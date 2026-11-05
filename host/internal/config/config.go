// Package config centraliza caminhos, identidade da extensão e o token de acesso.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

const (
	// HostName é o nome do native messaging host registrado no navegador.
	HostName = "com.oba.browser"
	// ExtensionID é derivado da chave pública fixada em extension/manifest.json.
	ExtensionID = "pfikhdcedpalmkfjbkldnfdiohhfomml"
	Version     = "0.2.0"
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

// HostInfo descreve o native host em execução (escrito por ele em host.json).
type HostInfo struct {
	Port int    `json:"port"`
	PID  int    `json:"pid"`
	Ext  string `json:"extension_origin"`
}

func WriteHostInfo(h HostInfo) error {
	p, err := path("host.json")
	if err != nil {
		return err
	}
	b, _ := json.Marshal(h)
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func ReadHostInfo() (HostInfo, error) {
	var h HostInfo
	p, err := path("host.json")
	if err != nil {
		return h, err
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return h, errors.New("native host não está rodando (host.json ausente)")
	}
	return h, json.Unmarshal(b, &h)
}

// RemoveHostInfo apaga host.json apenas se ele ainda pertencer a este processo.
func RemoveHostInfo() {
	p, err := path("host.json")
	if err != nil {
		return
	}
	if h, err := ReadHostInfo(); err == nil && h.PID == os.Getpid() {
		os.Remove(p)
	}
}

func LogPath() (string, error) { return path("host.log") }

func ManifestPath() (string, error) { return path(HostName + ".json") }
