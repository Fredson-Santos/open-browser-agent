package mcp

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"
)

const (
	artexMaxIngestBatch    = 50
	artexMaxIngestBodySize = 256 << 10 // 256 KiB, alinhado com ARTEX/server/traffic_ingest.go
)

// Configuração opcional do endpoint de ingestão do ARTEX (POST /api/traffic/ingest).
var (
	ArtexURL      = os.Getenv("OBA_ARTEX_URL")
	ArtexToken    = os.Getenv("OBA_ARTEX_TOKEN")
	ArtexInsecure = parseEnvBool(os.Getenv("OBA_ARTEX_INSECURE"))
)

func parseEnvBool(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// ExternalExchange espelha traffic.ExternalExchange do ARTEX.
type ExternalExchange struct {
	Method          string            `json:"method"`
	URL             string            `json:"url"`
	Status          int               `json:"status"`
	RequestHeaders  map[string]string `json:"requestHeaders"`
	RequestBody     string            `json:"requestBody"`
	ResponseHeaders map[string]string `json:"responseHeaders"`
	ResponseBody    string            `json:"responseBody"`
}

type artexCallOpts struct {
	Enabled  bool
	URL      string
	Token    string
	Insecure bool
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}

func stripArtexFields(obj map[string]any) (enabled bool, urlOverride, tokenOverride string, changed bool) {
	if b, ok := obj["artex_ingest"].(bool); ok && b {
		enabled = true
	}
	if u, ok := obj["artex_url"].(string); ok {
		urlOverride = strings.TrimSpace(u)
	}
	if _, exists := obj["artex_url"]; exists {
		delete(obj, "artex_url")
		changed = true
	}
	if t, ok := obj["artex_token"].(string); ok {
		tokenOverride = strings.TrimSpace(t)
	}
	if _, exists := obj["artex_token"]; exists {
		delete(obj, "artex_token")
		changed = true
	}
	return enabled, urlOverride, tokenOverride, changed
}

// extractArtexCallOpts lê artex_ingest / artex_url / artex_token e remove segredos
// (artex_url e artex_token) antes de repassar os argumentos à extensão.
func extractArtexCallOpts(tool string, rawArgs json.RawMessage) (json.RawMessage, artexCallOpts) {
	opts := artexCallOpts{
		URL:      strings.TrimSpace(ArtexURL),
		Token:    strings.TrimSpace(ArtexToken),
		Insecure: ArtexInsecure,
	}
	if len(bytes.TrimSpace(rawArgs)) == 0 {
		return rawArgs, opts
	}
	var m map[string]any
	if err := json.Unmarshal(rawArgs, &m); err != nil || m == nil {
		return rawArgs, opts
	}

	enabled, u, tok, changed := stripArtexFields(m)
	if u != "" {
		opts.URL = u
	}
	if tok != "" {
		opts.Token = tok
	}

	supportsTop := tool == "read_network" || tool == "http_repeater"
	if supportsTop && enabled {
		opts.Enabled = true
	}

	if tool == "batch" {
		if rawActions, ok := m["actions"].([]any); ok {
			for _, item := range rawActions {
				step, ok := item.(map[string]any)
				if !ok {
					continue
				}
				stepTool, _ := step["tool"].(string)
				stepArgs, ok := step["args"].(map[string]any)
				if !ok {
					continue
				}
				sEn, sURL, sTok, sChg := stripArtexFields(stepArgs)
				if sChg {
					changed = true
				}
				if (stepTool == "read_network" || stepTool == "http_repeater") && sEn {
					opts.Enabled = true
					if sURL != "" && u == "" {
						opts.URL = sURL
						u = sURL
					}
					if sTok != "" && tok == "" {
						opts.Token = sTok
						tok = sTok
					}
				}
			}
		}
	}

	if !changed {
		return rawArgs, opts
	}
	clean, err := json.Marshal(m)
	if err != nil {
		return rawArgs, opts
	}
	return clean, opts
}

func validHTTPHeaderName(name string) bool {
	if name == "" {
		return false
	}
	for i := 0; i < len(name); i++ {
		c := name[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case strings.IndexByte("!#$%&'*+-.^_`|~", c) >= 0:
		default:
			return false
		}
	}
	return true
}

// sanitizeHeaders normaliza chaves em lowercase (exigido por ARTEX/traffic/external.go),
// descarta pseudo-headers (:) / nomes inválidos e remove CR/LF/NUL dos valores.
func sanitizeHeaders(in map[string]string) map[string]string {
	out := map[string]string{}
	if len(in) == 0 {
		return out
	}
	keys := make([]string, 0, len(in))
	for k := range in {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	for _, orig := range keys {
		val := in[orig]
		low := strings.ToLower(strings.TrimSpace(orig))
		if low == "" || strings.HasPrefix(low, ":") || !validHTTPHeaderName(low) {
			continue
		}
		sep := ", "
		if low == "cookie" || low == "set-cookie" {
			sep = "; "
		}
		clean := strings.ReplaceAll(val, "\x00", "")
		clean = strings.ReplaceAll(clean, "\r\n", sep)
		clean = strings.ReplaceAll(clean, "\n", sep)
		clean = strings.ReplaceAll(clean, "\r", sep)
		out[low] = clean
	}
	return out
}

func truncateArtexBody(s string) string {
	if len(s) <= artexMaxIngestBodySize {
		return s
	}
	return s[:artexMaxIngestBodySize]
}

// IngestExchanges envia trocas HTTP em lotes de até 50 para POST <baseURL>/api/traffic/ingest.
func IngestExchanges(ctx context.Context, baseURL, token string, insecure bool, exchanges []ExternalExchange) (int, int, error) {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return 0, len(exchanges), fmt.Errorf("artex_url inválida: %q", baseURL)
	}
	tok := strings.TrimSpace(token)
	if tok == "" {
		return 0, len(exchanges), fmt.Errorf("artex_token vazio")
	}

	var clean []ExternalExchange
	skipped := 0
	for _, e := range exchanges {
		rawURL := strings.TrimSpace(e.URL)
		eu, err := url.Parse(rawURL)
		if err != nil || (eu.Scheme != "http" && eu.Scheme != "https") || eu.Host == "" {
			skipped++
			continue
		}
		method := strings.ToUpper(strings.TrimSpace(e.Method))
		if !validHTTPHeaderName(method) {
			skipped++
			continue
		}
		clean = append(clean, ExternalExchange{
			Method:          method,
			URL:             rawURL,
			Status:          e.Status,
			RequestHeaders:  sanitizeHeaders(e.RequestHeaders),
			RequestBody:     truncateArtexBody(e.RequestBody),
			ResponseHeaders: sanitizeHeaders(e.ResponseHeaders),
			ResponseBody:    truncateArtexBody(e.ResponseBody),
		})
	}
	if len(clean) == 0 {
		return 0, skipped, nil
	}

	hc := &http.Client{Timeout: 15 * time.Second}
	if insecure {
		hc.Transport = &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
	}

	endpoint := base + "/api/traffic/ingest"
	totalIngested, totalFailed := 0, skipped
	for i := 0; i < len(clean); i += artexMaxIngestBatch {
		end := i + artexMaxIngestBatch
		if end > len(clean) {
			end = len(clean)
		}
		batch := clean[i:end]
		payload, err := json.Marshal(struct {
			Exchanges []ExternalExchange `json:"exchanges"`
		}{Exchanges: batch})
		if err != nil {
			return totalIngested, totalFailed + (len(clean) - i), err
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
		if err != nil {
			return totalIngested, totalFailed + (len(clean) - i), err
		}
		req.Header.Set("Authorization", "Bearer "+tok)
		req.Header.Set("Content-Type", "application/json")

		resp, err := hc.Do(req)
		if err != nil {
			return totalIngested, totalFailed + (len(clean) - i), fmt.Errorf("falha ao conectar em %s: %w", endpoint, err)
		}
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			snippet := strings.TrimSpace(string(bodyBytes))
			if len(snippet) > 300 {
				snippet = snippet[:300]
			}
			return totalIngested, totalFailed + (len(clean) - i), fmt.Errorf("HTTP %d em %s: %s", resp.StatusCode, endpoint, snippet)
		}
		var out struct {
			Ingested int `json:"ingested"`
			Failed   int `json:"failed"`
		}
		if err := json.Unmarshal(bodyBytes, &out); err != nil {
			return totalIngested, totalFailed + (len(clean) - i), fmt.Errorf("resposta inválida do ARTEX: %w", err)
		}
		totalIngested += out.Ingested
		totalFailed += out.Failed
	}
	return totalIngested, totalFailed, nil
}

// processArtexIngest remove o campo interno _artex_exchanges da resposta MCP e,
// quando artex_ingest=true, envia os pares ao ARTEX anexando um resumo textual.
func processArtexIngest(ctx context.Context, rawRes json.RawMessage, opts artexCallOpts) json.RawMessage {
	if len(bytes.TrimSpace(rawRes)) == 0 {
		return rawRes
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(rawRes, &obj); err != nil || obj == nil {
		return rawRes
	}
	rawEx, hasEx := obj["_artex_exchanges"]
	if hasEx {
		delete(obj, "_artex_exchanges")
	}

	var isErr bool
	if errRaw, ok := obj["isError"]; ok {
		_ = json.Unmarshal(errRaw, &isErr)
	}
	if !opts.Enabled || isErr {
		if !hasEx {
			return rawRes
		}
		cleaned, err := json.Marshal(obj)
		if err != nil {
			return rawRes
		}
		return cleaned
	}

	var exchanges []ExternalExchange
	if hasEx {
		_ = json.Unmarshal(rawEx, &exchanges)
	}

	var note string
	switch {
	case len(exchanges) == 0:
		note = "\n\n[ARTEX ingest] nenhuma troca HTTP elegível para envio."
	case strings.TrimSpace(opts.URL) == "" || strings.TrimSpace(opts.Token) == "":
		note = "\n\n[ARTEX ingest] não enviado: configure --artex-url/--artex-token (ou OBA_ARTEX_URL/OBA_ARTEX_TOKEN)."
	default:
		ingested, failed, err := IngestExchanges(ctx, opts.URL, opts.Token, opts.Insecure, exchanges)
		if err != nil {
			note = fmt.Sprintf("\n\n[ARTEX ingest] erro: %v", err)
		} else {
			base := strings.TrimRight(strings.TrimSpace(opts.URL), "/")
			note = fmt.Sprintf("\n\n[ARTEX ingest] ✓ %d troca(s) enviada(s) para %s/api/traffic/ingest (falhas: %d).", ingested, base, failed)
		}
	}

	appendResultNote(obj, note)
	updated, err := json.Marshal(obj)
	if err != nil {
		return rawRes
	}
	return updated
}

func appendResultNote(obj map[string]json.RawMessage, note string) {
	var blocks []map[string]any
	if rawContent, ok := obj["content"]; ok {
		_ = json.Unmarshal(rawContent, &blocks)
	}
	appended := false
	for _, b := range blocks {
		if t, _ := b["type"].(string); t == "text" {
			cur, _ := b["text"].(string)
			b["text"] = cur + note
			appended = true
			break
		}
	}
	if !appended {
		blocks = append(blocks, map[string]any{
			"type": "text",
			"text": strings.TrimLeft(note, "\n"),
		})
	}
	if b, err := json.Marshal(blocks); err == nil {
		obj["content"] = b
	}
}
