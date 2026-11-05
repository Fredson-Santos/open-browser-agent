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
	Port    int    `json:"port"`
	PID     int    `json:"pid"`
	Ext     string `json:"extension_origin"`
	Browser string `json:"browser,omitempty"`
	Started int64  `json:"started"` // unix ms
	Path    string `json:"-"`
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
