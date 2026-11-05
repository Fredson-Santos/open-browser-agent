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
	"oba/internal/hub"
	"oba/internal/install"
	"oba/internal/mcp"
)

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
		fs.Parse(os.Args[2:])
		if *browser != "" {
			mcp.Browser = *browser
		}
		err = mcp.Run()
	case "install":
		fs := flag.NewFlagSet("install", flag.ExitOnError)
		ids := fs.String("extension-id", "", "IDs extras de extensão autorizados, separados por vírgula")
		fs.Parse(os.Args[2:])
		var extra []string
		if *ids != "" {
			extra = strings.Split(*ids, ",")
		}
		if err = install.Install(extra); err == nil {
			exe, _ := os.Executable()
			fmt.Printf("\nPronto. Configure o agente com:\n  claude mcp add oba -- \"%s\" mcp\n", exe)
			cfg, _ := json.MarshalIndent(map[string]any{"mcpServers": map[string]any{
				"oba": map[string]any{"command": exe, "args": []string{"mcp"}},
			}}, "", "  ")
			fmt.Printf("\nou, em clientes com JSON (Cursor, Antigravity, Claude Desktop…):\n%s\n", cfg)
		}
	case "uninstall":
		err = install.Uninstall()
	case "status":
		err = status()
	case "version", "-v", "--version":
		fmt.Println("oba", config.Version)
	default:
		fmt.Fprintln(os.Stderr, "uso: oba <install|uninstall|mcp|status|version>")
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "erro:", err)
		os.Exit(1)
	}
}

func status() error {
	hosts, err := config.ListHosts()
	if err != nil {
		return err
	}
	if len(hosts) == 0 {
		fmt.Println("✗ nenhum navegador conectado (abra o navegador com a extensão OBA ativa)")
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
		since := time.UnixMilli(h.Started).Format("15:04:05")
		fmt.Printf("%s %-8s pid %-6d porta %-5d desde %s\n", mark, name, h.PID, h.Port, since)
	}
	if err := mcp.Probe(); err != nil {
		fmt.Println("✗ handshake falhou:", err)
		return nil
	}
	fmt.Println("✓ conexão ok (* = usado por padrão; escolha outro com `oba mcp --browser <nome>` ou OBA_BROWSER)")
	return nil
}
