// Package install registra o native messaging host nos navegadores.
package install

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"oba/internal/config"
)

type browser struct {
	Name   string
	RegKey string // Windows (HKCU)
	MacDir string // relativo a ~/Library/Application Support
	LinDir string // relativo a ~/.config
}

var browsers = []browser{
	{"Brave", `HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\`, "BraveSoftware/Brave-Browser", "BraveSoftware/Brave-Browser"},
	{"Chrome", `HKCU\Software\Google\Chrome\NativeMessagingHosts\`, "Google/Chrome", "google-chrome"},
	{"Edge", `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\`, "Microsoft Edge", "microsoft-edge"},
}

type manifest struct {
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	Path           string   `json:"path"`
	Type           string   `json:"type"`
	AllowedOrigins []string `json:"allowed_origins"`
}

// Install grava o manifesto do host e o registra em cada navegador.
func Install(extraIDs []string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, _ = filepath.EvalSymlinks(exe)
	if strings.Contains(strings.ToLower(exe), strings.ToLower(os.TempDir())) {
		return fmt.Errorf("o executável está numa pasta temporária (%s); rode `go install .` e use o binário instalado", exe)
	}
	if _, err := config.Token(); err != nil {
		return err
	}

	origins := []string{"chrome-extension://" + config.ExtensionID + "/"}
	for _, id := range extraIDs {
		origins = append(origins, "chrome-extension://"+strings.TrimSpace(id)+"/")
	}
	m := manifest{
		Name:           config.HostName,
		Description:    "OBA — ponte entre agentes de IA e o navegador",
		Path:           exe,
		Type:           "stdio",
		AllowedOrigins: origins,
	}
	b, _ := json.MarshalIndent(m, "", "  ")

	if runtime.GOOS == "windows" {
		mp, err := config.ManifestPath()
		if err != nil {
			return err
		}
		if err := os.WriteFile(mp, b, 0o644); err != nil {
			return err
		}
		fmt.Println("manifesto:", mp)
		for _, br := range browsers {
			key := br.RegKey + config.HostName
			out, err := exec.Command("reg", "add", key, "/ve", "/t", "REG_SZ", "/d", mp, "/f").CombinedOutput()
			if err != nil {
				return fmt.Errorf("%s: %v: %s", br.Name, err, out)
			}
			fmt.Printf("  ✓ %s\n", br.Name)
		}
		return nil
	}

	for _, br := range browsers {
		dir, err := unixDir(br)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		p := filepath.Join(dir, config.HostName+".json")
		if err := os.WriteFile(p, b, 0o644); err != nil {
			return err
		}
		fmt.Printf("  ✓ %s: %s\n", br.Name, p)
	}
	return nil
}

// Uninstall remove o registro dos navegadores.
func Uninstall() error {
	if runtime.GOOS == "windows" {
		for _, br := range browsers {
			exec.Command("reg", "delete", br.RegKey+config.HostName, "/f").Run()
			fmt.Printf("  ✓ %s\n", br.Name)
		}
		if mp, err := config.ManifestPath(); err == nil {
			os.Remove(mp)
		}
		return nil
	}
	for _, br := range browsers {
		if dir, err := unixDir(br); err == nil {
			os.Remove(filepath.Join(dir, config.HostName+".json"))
			fmt.Printf("  ✓ %s\n", br.Name)
		}
	}
	return nil
}

func unixDir(br browser) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support", br.MacDir, "NativeMessagingHosts"), nil
	}
	return filepath.Join(home, ".config", br.LinDir, "NativeMessagingHosts"), nil
}
