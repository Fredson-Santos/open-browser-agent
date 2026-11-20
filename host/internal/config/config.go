// Package config centraliza caminhos, identidade da extensão e o token de acesso.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	// HostName é o nome do native messaging host registrado no navegador.
	HostName = "com.oba.browser"
	// ExtensionID é derivado da chave pública fixada em extension/manifest.json.
	ExtensionID = "pfikhdcedpalmkfjbkldnfdiohhfomml"
	Version     = "0.5.0"
)

// Dir retorna o diretório de dados do OBA (%APPDATA%\oba no Windows).
func Dir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "oba")
	return dir, os.MkdirAll(dir, 0o700)
}

func path(name string) (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, name), nil
}

// Token retorna o token compartilhado entre o native host e os clientes MCP,
// criando-o na primeira chamada.
func Token() (string, error) {
	p, err := path("token")
	if err != nil {
		return "", err
	}
	if b, err := os.ReadFile(p); err == nil && len(strings.TrimSpace(string(b))) >= 32 {
		return strings.TrimSpace(string(b)), nil
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	tok := hex.EncodeToString(buf)
	return tok, os.WriteFile(p, []byte(tok), 0o600)
}

// HostInfo descreve um native host em execução. Cada navegador (ou perfil)
// com a extensão ativa inicia o seu, e cada um grava hosts/<pid>.json.
type HostInfo struct {
	Port     int    `json:"port"`
	PID      int    `json:"pid"`
	Ext      string `json:"extension_origin"`
	Browser  string `json:"browser,omitempty"`
	Headless bool   `json:"headless,omitempty"`
	Started  int64  `json:"started"` // unix ms
	Path     string `json:"-"`
}

// CybersecConfig guarda a confirmação explícita do usuário (`oba install --cybersec`)
// para permitir o modo stealth/autônomo sem popups.
type CybersecConfig struct {
	Enabled      bool   `json:"enabled"`
	ExtensionDir string `json:"extension_dir,omitempty"`
	BrowserBin   string `json:"browser_bin,omitempty"`
	EnabledAt    string `json:"enabled_at,omitempty"`
}

// HeadlessState registra a instância headless iniciada pelo `oba mcp --headless`.
type HeadlessState struct {
	Browser    string `json:"browser"`
	BrowserPID int    `json:"browser_pid"`
	HostPID    int    `json:"host_pid"`
	HostPort   int    `json:"host_port"`
	ProfileDir string `json:"profile_dir"`
	Started    int64  `json:"started"`
}

func hostsDir() (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	d := filepath.Join(dir, "hosts")
	return d, os.MkdirAll(d, 0o700)
}

func WriteHostInfo(h HostInfo) error {
	dir, err := hostsDir()
	if err != nil {
		return err
	}
	p := filepath.Join(dir, fmt.Sprintf("%d.json", h.PID))
	b, _ := json.Marshal(h)
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// ListHosts retorna os hosts registrados, do mais recente para o mais antigo.
func ListHosts() ([]HostInfo, error) {
	dir, err := hostsDir()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var hosts []HostInfo
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		p := filepath.Join(dir, e.Name())
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var h HostInfo
		if json.Unmarshal(b, &h) == nil && h.Port > 0 {
			h.Path = p
			hosts = append(hosts, h)
		}
	}
	sort.Slice(hosts, func(i, j int) bool { return hosts[i].Started > hosts[j].Started })
	return hosts, nil
}

// RemoveHostInfo apaga o registro deste processo.
func RemoveHostInfo() {
	if dir, err := hostsDir(); err == nil {
		os.Remove(filepath.Join(dir, fmt.Sprintf("%d.json", os.Getpid())))
	}
}

func LogPath() (string, error) { return path("host.log") }

func ManifestPath() (string, error) { return path(HostName + ".json") }

func CybersecConfigPath() (string, error) { return path("cybersec.json") }

func HeadlessStatePath() (string, error) { return path("headless.json") }

func HeadlessProfileDir() (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	p := filepath.Join(dir, "cybersec-profile")
	return p, os.MkdirAll(p, 0o700)
}

func LoadCybersecConfig() (CybersecConfig, error) {
	p, err := CybersecConfigPath()
	if err != nil {
		return CybersecConfig{}, err
	}
	b, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return CybersecConfig{}, nil
		}
		return CybersecConfig{}, err
	}
	var c CybersecConfig
	if err := json.Unmarshal(b, &c); err != nil {
		return CybersecConfig{}, err
	}
	return c, nil
}

func SaveCybersecConfig(c CybersecConfig) error {
	p, err := CybersecConfigPath()
	if err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func IsCybersecEnabled() bool {
	c, err := LoadCybersecConfig()
	return err == nil && c.Enabled
}

func LoadHeadlessState() (HeadlessState, error) {
	p, err := HeadlessStatePath()
	if err != nil {
		return HeadlessState{}, err
	}
	b, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return HeadlessState{}, nil
		}
		return HeadlessState{}, err
	}
	var st HeadlessState
	if err := json.Unmarshal(b, &st); err != nil {
		return HeadlessState{}, err
	}
	return st, nil
}

func SaveHeadlessState(st HeadlessState) error {
	p, err := HeadlessStatePath()
	if err != nil {
		return err
	}
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func RemoveHeadlessState() {
	if p, err := HeadlessStatePath(); err == nil {
		os.Remove(p)
	}
}
