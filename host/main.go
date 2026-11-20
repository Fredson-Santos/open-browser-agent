// oba — Open Browser Agent: conecta qualquer agente MCP ao navegador.
//
//	oba install      registra o native host no Brave, Chrome e Edge
//	oba uninstall    remove o registro
//	oba mcp          servidor MCP via stdio (configure isto no seu agente)
//	oba status       mostra se o navegador está conectado
//
// O navegador inicia o mesmo binário como native host, passando a origem da
// extensão (chrome-extension://...) como primeiro argumento.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"oba/internal/config"
	"oba/internal/headless"
	"oba/internal/hub"
	"oba/internal/install"
	"oba/internal/mcp"
)

func envBool(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func main() {
	if len(os.Args) > 1 && strings.HasPrefix(os.Args[1], "chrome-extension://") {
		if err := hub.Run(os.Args[1]); err != nil {
			os.Exit(1)
		}
		return
	}

	cmd := ""
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	var err error
	switch cmd {
	case "mcp":
		fs := flag.NewFlagSet("mcp", flag.ExitOnError)
		browser := fs.String("browser", "", "navegador a controlar (brave, chrome, edge…); padrão: o mais recente")
		session := fs.String("session", "", "chave da sessão: processos com a mesma chave reusam o mesmo grupo de abas; padrão: cliente + diretório atual (ou OBA_SESSION)")
		useHeadless := fs.Bool("headless", envBool("OBA_HEADLESS"), "inicia ou reutiliza um navegador --headless=new invisível com a extensão OBA carregada (exige --cybersec)")
		cybersec := fs.Bool("cybersec", false, "ativa modo CyberSec/stealth (zero popups, sem overlay, leitura irrestrita); exige também OBA_CYBERSEC=1 e `oba install --cybersec`")
		extDir := fs.String("extension-dir", "", "caminho para extension/dist (ou OBA_EXT_DIR)")
		proxy := fs.String("proxy", "", "proxy HTTP para o navegador headless (ou OBA_PROXY, ex.: http://127.0.0.1:8788)")
		httpAddr := fs.String("http", os.Getenv("OBA_HTTP"), "expõe MCP Streamable HTTP em <addr> (ex.: 127.0.0.1:8789) em /mcp em vez de stdio (ou OBA_HTTP)")
		httpToken := fs.String("http-token", os.Getenv("OBA_HTTP_TOKEN"), "token Bearer exigido em Authorization para --http (ou OBA_HTTP_TOKEN)")
		artexURL := fs.String("artex-url", os.Getenv("OBA_ARTEX_URL"), "URL base do ARTEX para ingest de tráfego em /api/traffic/ingest (ou OBA_ARTEX_URL)")
		artexToken := fs.String("artex-token", os.Getenv("OBA_ARTEX_TOKEN"), "token JWT Bearer do ARTEX para /api/traffic/ingest (ou OBA_ARTEX_TOKEN)")
		artexInsecure := fs.Bool("artex-insecure", envBool("OBA_ARTEX_INSECURE"), "ignora erros de certificado TLS ao enviar tráfego para --artex-url (ou OBA_ARTEX_INSECURE=1)")
		fs.Parse(os.Args[2:])
		if *useHeadless && !*cybersec {
			fmt.Fprintln(os.Stderr, "erro: --headless exige --cybersec (com OBA_CYBERSEC=1 e `oba install --cybersec`): no modo headless não há janela visível para aprovar popups de permissão.")
			os.Exit(1)
		}
		if *cybersec {
			if !envBool("OBA_CYBERSEC") {
				fmt.Fprintln(os.Stderr, "erro: --cybersec exige também a variável de ambiente OBA_CYBERSEC=1 (gate de segurança explícito).")
				os.Exit(1)
			}
			if !config.IsCybersecEnabled() {
				fmt.Fprintln(os.Stderr, "erro: --cybersec não está habilitado neste host: confirme primeiro com `oba install --cybersec`.")
				os.Exit(1)
			}
			mcp.Stealth = true
		}
		mcp.Headless = *useHeadless
		mcp.HTTPToken = *httpToken
		mcp.ArtexURL = *artexURL
		mcp.ArtexToken = *artexToken
		mcp.ArtexInsecure = *artexInsecure
		if *extDir != "" {
			mcp.ExtensionDir = *extDir
		}
		if *proxy != "" {
			mcp.Proxy = *proxy
		}
		if *browser != "" {
			mcp.Browser = *browser
		}
		if *session != "" {
			mcp.Session = *session
		}
		if *httpAddr != "" {
			err = mcp.RunHTTP(*httpAddr)
		} else {
			err = mcp.Run()
		}
	case "install":
		fs := flag.NewFlagSet("install", flag.ExitOnError)
		ids := fs.String("extension-id", "", "IDs extras de extensão autorizados, separados por vírgula")
		cybersec := fs.Bool("cybersec", false, "habilita o gate de host para o modo CyberSec/stealth (auto-aprovação, sem overlay, leitura irrestrita)")
		disableCybersec := fs.Bool("disable-cybersec", false, "desabilita o modo CyberSec/stealth neste host")
		extDir := fs.String("extension-dir", "", "caminho de extension/dist para salvar no perfil CyberSec (auto-detectado se omitido)")
		browserBin := fs.String("browser-bin", "", "caminho opcional do executável do navegador headless para salvar no perfil CyberSec")
		fs.Parse(os.Args[2:])
		var extra []string
		if *ids != "" {
			extra = strings.Split(*ids, ",")
		}
		if err = install.Install(extra); err == nil {
			if *disableCybersec {
				if err = config.SaveCybersecConfig(config.CybersecConfig{Enabled: false}); err != nil {
					break
				}
				fmt.Println("\n✓ Modo CyberSec/stealth DESABILITADO neste host.")
			} else if *cybersec {
				resolvedExt, _ := headless.ResolveExtensionDir(*extDir)
				c := config.CybersecConfig{
					Enabled:      true,
					ExtensionDir: resolvedExt,
					BrowserBin:   strings.TrimSpace(*browserBin),
					EnabledAt:    time.Now().UTC().Format(time.RFC3339),
				}
				if err = config.SaveCybersecConfig(c); err != nil {
					break
				}
				fmt.Println("\n⚠ MODO CYBERSEC/STEALTH HABILITADO NESTE HOST:")
				fmt.Println("  Quando invocado com `--cybersec` + `OBA_CYBERSEC=1`, o OBA aprovará conexões, sites,")
				fmt.Println("  uploads e execução de JavaScript sem popups, sem overlay e sem redação de senhas.")
				if resolvedExt != "" {
					fmt.Printf("  extension/dist salvo: %s\n", resolvedExt)
				} else {
					fmt.Println("  aviso: extension/dist não localizado automaticamente; informe --extension-dir ou OBA_EXT_DIR ao usar --headless.")
				}
			}
			exe, _ := os.Executable()
			fmt.Printf("\nPronto. Configure o agente com:\n  claude mcp add oba -- \"%s\" mcp\n", exe)
			cfg, _ := json.MarshalIndent(map[string]any{"mcpServers": map[string]any{
				"oba": map[string]any{"command": exe, "args": []string{"mcp"}},
			}}, "", "  ")
			fmt.Printf("\nou, em clientes com JSON (Cursor, Antigravity, Claude Desktop…):\n%s\n", cfg)
		}
	case "uninstall":
		err = install.Uninstall()
	case "stop-headless":
		var stopped bool
		stopped, err = headless.Stop()
		if err == nil {
			if stopped {
				fmt.Println("✓ instância headless encerrada")
			} else {
				fmt.Println("nenhuma instância headless registrada")
			}
		}
	case "status":
		err = status()
	case "version", "-v", "--version":
		fmt.Println("oba", config.Version)
	default:
		fmt.Fprintln(os.Stderr, "uso: oba <install|uninstall|mcp|status|stop-headless|version>")
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "erro:", err)
		os.Exit(1)
	}
}

func status() error {
	cyber := "desabilitado"
	if config.IsCybersecEnabled() {
		cyber = "habilitado"
	}
	hosts, err := config.ListHosts()
	if err != nil {
		return err
	}
	if len(hosts) == 0 {
		fmt.Printf("✗ nenhum navegador conectado (cybersec: %s)\n", cyber)
		return nil
	}
	for i, h := range hosts {
		name := h.Browser
		if name == "" {
			name = "navegador"
		}
		mark := " "
		if i == 0 {
			mark = "*"
		}
		tag := ""
		if h.Headless {
			tag = " [headless]"
		}
		since := time.UnixMilli(h.Started).Format("15:04:05")
		fmt.Printf("%s %-8s pid %-6d porta %-5d desde %s%s\n", mark, name, h.PID, h.Port, since, tag)
	}
	if err := mcp.Probe(); err != nil {
		fmt.Println("✗ handshake falhou:", err)
		return nil
	}
	fmt.Printf("✓ conexão ok (cybersec: %s; * = usado por padrão; escolha outro com `oba mcp --browser <nome>` ou OBA_BROWSER)\n", cyber)
	return nil
}
