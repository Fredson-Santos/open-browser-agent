// Package headless inicia e gerencia um navegador Chromium/Brave/Edge em modo
// --headless=new com a extensão OBA carregada para uso autônomo pelo ARTEX/MCP.
package headless

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"oba/internal/config"
)

type Options struct {
	Browser          string
	ExtensionDir     string
	ProfileDir       string
	Proxy            string
	IgnoreCertErrors bool
}

var launchMu sync.Mutex

func canDial(port int) bool {
	if port <= 0 {
		return false
	}
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 800*time.Millisecond)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

func inferBrowserName(bin string) string {
	low := strings.ToLower(filepath.Base(bin))
	switch {
	case strings.Contains(low, "brave"):
		return "Brave"
	case strings.Contains(low, "edge"):
		return "Edge"
	case strings.Contains(low, "chromium"):
		return "Chromium"
	case strings.Contains(low, "chrome"):
		return "Chrome"
	default:
		return "Chromium"
	}
}

func browserMatches(candidateName, preferred string) bool {
	want := strings.ToLower(strings.TrimSpace(preferred))
	if want == "" {
		return true
	}
	return strings.Contains(strings.ToLower(candidateName), want)
}

// FindBrowser localiza um executável compatível com --load-extension em --headless=new.
// Prefere Brave → Edge → Chromium (builds oficiais do Google Chrome 137+ ignoram --load-extension).
func FindBrowser(preferred string) (name, bin string, err error) {
	if envBin := strings.TrimSpace(os.Getenv("OBA_BROWSER_BIN")); envBin != "" {
		if st, statErr := os.Stat(envBin); statErr == nil && !st.IsDir() {
			return inferBrowserName(envBin), envBin, nil
		}
		if lp, lpErr := exec.LookPath(envBin); lpErr == nil {
			return inferBrowserName(lp), lp, nil
		}
		return "", "", fmt.Errorf("OBA_BROWSER_BIN (%q) não encontrado", envBin)
	}

	if cfg, cfgErr := config.LoadCybersecConfig(); cfgErr == nil && strings.TrimSpace(cfg.BrowserBin) != "" {
		b := strings.TrimSpace(cfg.BrowserBin)
		if st, statErr := os.Stat(b); statErr == nil && !st.IsDir() {
			return inferBrowserName(b), b, nil
		}
	}

	want := strings.ToLower(strings.TrimSpace(preferred))
	if want == "chrome" || want == "google chrome" {
		return "", "", errors.New("Google Chrome oficial (137+) bloqueia --load-extension em modo headless; use --browser brave, --browser edge, ou defina OBA_BROWSER_BIN apontando para Chromium / Chrome for Testing")
	}

	type cand struct {
		name string
		path string
	}
	var candidates []cand

	switch runtime.GOOS {
	case "windows":
		pf := os.Getenv("ProgramFiles")
		pf86 := os.Getenv("ProgramFiles(x86)")
		local := os.Getenv("LOCALAPPDATA")
		add := func(bname, p string) {
			if p != "" {
				candidates = append(candidates, cand{bname, p})
			}
		}
		add("Brave", filepath.Join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"))
		add("Brave", filepath.Join(pf86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"))
		add("Brave", filepath.Join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"))
		add("Edge", filepath.Join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"))
		add("Edge", filepath.Join(pf, "Microsoft", "Edge", "Application", "msedge.exe"))
		add("Edge", filepath.Join(local, "Microsoft", "Edge", "Application", "msedge.exe"))
		add("Chromium", filepath.Join(local, "Chromium", "Application", "chrome.exe"))
	case "darwin":
		candidates = append(candidates,
			cand{"Brave", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"},
			cand{"Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"},
			cand{"Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium"},
		)
	default:
		for _, pair := range []cand{
			{"Brave", "brave-browser"},
			{"Brave", "brave"},
			{"Edge", "microsoft-edge"},
			{"Chromium", "chromium"},
			{"Chromium", "chromium-browser"},
		} {
			if lp, err := exec.LookPath(pair.path); err == nil {
				candidates = append(candidates, cand{pair.name, lp})
			}
		}
	}

	for _, c := range candidates {
		if !browserMatches(c.name, want) {
			continue
		}
		if st, err := os.Stat(c.path); err == nil && !st.IsDir() {
			return c.name, c.path, nil
		}
	}

	if want != "" {
		return "", "", fmt.Errorf("nenhum navegador %q compatível encontrado; defina OBA_BROWSER_BIN ou use brave/edge", preferred)
	}
	return "", "", errors.New("nenhum navegador compatível (Brave, Edge ou Chromium) encontrado; defina OBA_BROWSER_BIN")
}

// ResolveExtensionDir localiza a pasta extension/dist (contendo manifest.json).
func ResolveExtensionDir(explicit string) (string, error) {
	var candidates []string
	add := func(d string) {
		d = strings.TrimSpace(d)
		if d != "" {
			candidates = append(candidates, d)
		}
	}
	add(explicit)
	add(os.Getenv("OBA_EXT_DIR"))
	if cfg, err := config.LoadCybersecConfig(); err == nil {
		add(cfg.ExtensionDir)
	}
	if cwd, err := os.Getwd(); err == nil {
		add(filepath.Join(cwd, "extension", "dist"))
		add(filepath.Join(cwd, "..", "extension", "dist"))
	}
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		add(filepath.Join(exeDir, "extension", "dist"))
		add(filepath.Join(exeDir, "..", "extension", "dist"))
		add(filepath.Join(exeDir, "..", "..", "extension", "dist"))
	}

	for _, c := range candidates {
		abs, err := filepath.Abs(c)
		if err != nil {
			continue
		}
		if st, err := os.Stat(filepath.Join(abs, "manifest.json")); err == nil && !st.IsDir() {
			return abs, nil
		}
	}
	return "", errors.New("pasta extension/dist não encontrada; informe --extension-dir, defina OBA_EXT_DIR ou rode 'oba install --cybersec --extension-dir <caminho>'")
}

// FindRunning procura uma instância headless já ativa e acessível via TCP.
func FindRunning(preferred string) (config.HostInfo, bool) {
	hosts, _ := config.ListHosts()
	for _, h := range hosts {
		if !h.Headless || !browserMatches(h.Browser, preferred) {
			continue
		}
		if canDial(h.Port) {
			return h, true
		}
		os.Remove(h.Path)
	}
	if st, err := config.LoadHeadlessState(); err == nil && st.HostPort > 0 && browserMatches(st.Browser, preferred) {
		if canDial(st.HostPort) {
			return config.HostInfo{
				Port:     st.HostPort,
				PID:      st.HostPID,
				Browser:  st.Browser,
				Headless: true,
				Started:  st.Started,
			}, true
		}
	}
	return config.HostInfo{}, false
}

// EnsureRunning garante que exista um navegador headless com a extensão OBA conectada.
func EnsureRunning(ctx context.Context, opts Options) (config.HostInfo, error) {
	launchMu.Lock()
	defer launchMu.Unlock()

	if h, ok := FindRunning(opts.Browser); ok {
		return h, nil
	}

	bName, bBin, err := FindBrowser(opts.Browser)
	if err != nil {
		return config.HostInfo{}, err
	}
	extDir, err := ResolveExtensionDir(opts.ExtensionDir)
	if err != nil {
		return config.HostInfo{}, err
	}
	profileDir := strings.TrimSpace(opts.ProfileDir)
	if profileDir == "" {
		profileDir = strings.TrimSpace(os.Getenv("OBA_HEADLESS_PROFILE"))
	}
	if profileDir == "" {
		profileDir, err = config.HeadlessProfileDir()
		if err != nil {
			return config.HostInfo{}, err
		}
	} else if err := os.MkdirAll(profileDir, 0o700); err != nil {
		return config.HostInfo{}, err
	}

	existingHosts, _ := config.ListHosts()
	before := map[string]bool{}
	for _, h := range existingHosts {
		before[filepath.Base(h.Path)] = true
	}

	args := []string{
		"--headless=new",
		"--user-data-dir=" + profileDir,
		"--load-extension=" + extDir,
		"--disable-extensions-except=" + extDir,
		"--disable-blink-features=AutomationControlled",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-popup-blocking",
		"--disable-background-networking",
		"--window-size=1440,900",
	}
	if opts.IgnoreCertErrors || strings.TrimSpace(opts.Proxy) != "" {
		args = append(args, "--ignore-certificate-errors")
	}
	if p := strings.TrimSpace(opts.Proxy); p != "" {
		args = append(args, "--proxy-server="+p)
	}
	args = append(args, "about:blank")

	cmd := exec.Command(bBin, args...)
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.Env = append(os.Environ(), "OBA_LAUNCHED_HEADLESS=1")
	applyDetached(cmd)

	if err := cmd.Start(); err != nil {
		return config.HostInfo{}, fmt.Errorf("falha ao iniciar %s headless: %w", bName, err)
	}
	waitCh := make(chan error, 1)
	go func() { waitCh <- cmd.Wait() }()

	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			_ = killProcessTree(cmd.Process.Pid)
			return config.HostInfo{}, ctx.Err()
		case waitErr := <-waitCh:
			// Alguns binários fazem handoff rápido; espera brevemente por um registro de host antes de falhar.
			time.Sleep(800 * time.Millisecond)
			if hosts, err := config.ListHosts(); err == nil {
				for _, h := range hosts {
					if !before[filepath.Base(h.Path)] && canDial(h.Port) {
						_ = config.SaveHeadlessState(config.HeadlessState{
							Browser:    bName,
							BrowserPID: cmd.Process.Pid,
							HostPID:    h.PID,
							HostPort:   h.Port,
							ProfileDir: profileDir,
							Started:    time.Now().UnixMilli(),
						})
						return h, nil
					}
				}
			}
			_ = killProcessTree(cmd.Process.Pid)
			return config.HostInfo{}, fmt.Errorf("%s headless encerrou antes de conectar o host nativo: %v", bName, waitErr)
		default:
		}

		if hosts, err := config.ListHosts(); err == nil {
			for _, h := range hosts {
				if before[filepath.Base(h.Path)] && !h.Headless {
					continue
				}
				if !before[filepath.Base(h.Path)] || h.Headless {
					if canDial(h.Port) {
						_ = config.SaveHeadlessState(config.HeadlessState{
							Browser:    bName,
							BrowserPID: cmd.Process.Pid,
							HostPID:    h.PID,
							HostPort:   h.Port,
							ProfileDir: profileDir,
							Started:    time.Now().UnixMilli(),
						})
						return h, nil
					}
				}
			}
		}
		time.Sleep(200 * time.Millisecond)
	}

	_ = killProcessTree(cmd.Process.Pid)
	return config.HostInfo{}, fmt.Errorf("tempo esgotado (12s) aguardando %s headless conectar à extensão OBA (verifique se `oba install` foi executado para este binário)", bName)
}

// Stop encerra a instância headless registrada, se houver.
func Stop() (bool, error) {
	st, err := config.LoadHeadlessState()
	if err != nil {
		return false, err
	}
	stopped := false
	if st.BrowserPID > 0 {
		if err := killProcessTree(st.BrowserPID); err == nil {
			stopped = true
		}
	}
	if hosts, err := config.ListHosts(); err == nil {
		for _, h := range hosts {
			if h.Headless || (st.HostPID > 0 && h.PID == st.HostPID) {
				if h.PID > 0 {
					_ = killProcessTree(h.PID)
					stopped = true
				}
				os.Remove(h.Path)
			}
		}
	}
	config.RemoveHeadlessState()
	return stopped, nil
}
