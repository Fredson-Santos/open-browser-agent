package mcp

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func doMCPPost(t *testing.T, url, token, sid, protoVer, accept, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if accept != "" {
		req.Header.Set("Accept", accept)
	} else {
		req.Header.Set("Accept", "application/json, text/event-stream")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if sid != "" {
		req.Header.Set("Mcp-Session-Id", sid)
	}
	if protoVer != "" {
		req.Header.Set("MCP-Protocol-Version", protoVer)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestStreamableHTTPFlow(t *testing.T) {
	srv := httptest.NewServer(NewHTTPHandler("secret-tok"))
	defer srv.Close()

	// 1. /health sem auth continua respondendo 200 com metadados e tools count = 23.
	hResp, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer hResp.Body.Close()
	if hResp.StatusCode != http.StatusOK {
		t.Fatalf("GET /health status = %d, want 200", hResp.StatusCode)
	}
	var health struct {
		OK    bool `json:"ok"`
		Tools int  `json:"tools"`
	}
	if err := json.NewDecoder(hResp.Body).Decode(&health); err != nil || !health.OK || health.Tools != 23 {
		t.Fatalf("GET /health = %+v (err=%v)", health, err)
	}

	mcpURL := srv.URL + "/mcp"

	// 2. Auth Bearer obrigatório quando token configurado.
	unauth := doMCPPost(t, mcpURL, "", "", "", "", `{"jsonrpc":"2.0","id":1,"method":"ping"}`)
	unauth.Body.Close()
	if unauth.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated POST /mcp status = %d, want 401", unauth.StatusCode)
	}
	badTok := doMCPPost(t, mcpURL, "wrong", "", "", "", `{"jsonrpc":"2.0","id":1,"method":"ping"}`)
	badTok.Body.Close()
	if badTok.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong-token POST /mcp status = %d, want 401", badTok.StatusCode)
	}

	// 3. Fluxo idêntico ao ARTEX/mcphttp/client.go: initialize -> notifications/initialized -> tools/list -> ping -> DELETE.
	initBody := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"artex","version":"0.2"}}}`
	initResp := doMCPPost(t, mcpURL, "secret-tok", "", "", "", initBody)
	initBytes, _ := io.ReadAll(initResp.Body)
	initResp.Body.Close()
	if initResp.StatusCode != http.StatusOK {
		t.Fatalf("initialize status = %d body = %s", initResp.StatusCode, initBytes)
	}
	sid := initResp.Header.Get("Mcp-Session-Id")
	if sid == "" {
		t.Fatal("missing Mcp-Session-Id on initialize")
	}
	var initRPC struct {
		Result struct {
			ProtocolVersion string `json:"protocolVersion"`
			ServerInfo      struct {
				Name string `json:"name"`
			} `json:"serverInfo"`
		} `json:"result"`
	}
	if err := json.Unmarshal(initBytes, &initRPC); err != nil || initRPC.Result.ProtocolVersion != "2025-11-25" || initRPC.Result.ServerInfo.Name != "oba" {
		t.Fatalf("unexpected initialize body: %s", initBytes)
	}

	notif := doMCPPost(t, mcpURL, "secret-tok", sid, "2025-11-25", "", `{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}`)
	notif.Body.Close()
	if notif.StatusCode != http.StatusAccepted {
		t.Fatalf("notifications/initialized status = %d, want 202", notif.StatusCode)
	}

	toolsResp := doMCPPost(t, mcpURL, "secret-tok", sid, "2025-11-25", "", `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`)
	toolsBytes, _ := io.ReadAll(toolsResp.Body)
	toolsResp.Body.Close()
	if toolsResp.StatusCode != http.StatusOK {
		t.Fatalf("tools/list status = %d body = %s", toolsResp.StatusCode, toolsBytes)
	}
	var toolsRPC struct {
		Result struct {
			Tools []Tool `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(toolsBytes, &toolsRPC); err != nil || len(toolsRPC.Result.Tools) != 23 {
		t.Fatalf("tools/list len = %d (err=%v)", len(toolsRPC.Result.Tools), err)
	}

	pingResp := doMCPPost(t, mcpURL, "secret-tok", sid, "2025-11-25", "", `{"jsonrpc":"2.0","id":3,"method":"ping","params":{}}`)
	pingResp.Body.Close()
	if pingResp.StatusCode != http.StatusOK {
		t.Fatalf("ping status = %d, want 200", pingResp.StatusCode)
	}

	// DELETE encerra a sessão (204) e chamadas posteriores recebem 404.
	delReq, _ := http.NewRequest(http.MethodDelete, mcpURL, nil)
	delReq.Header.Set("Authorization", "Bearer secret-tok")
	delReq.Header.Set("Mcp-Session-Id", sid)
	delResp, err := http.DefaultClient.Do(delReq)
	if err != nil {
		t.Fatal(err)
	}
	delResp.Body.Close()
	if delResp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE /mcp status = %d, want 204", delResp.StatusCode)
	}

	afterDel := doMCPPost(t, mcpURL, "secret-tok", sid, "2025-11-25", "", `{"jsonrpc":"2.0","id":4,"method":"ping"}`)
	afterDel.Body.Close()
	if afterDel.StatusCode != http.StatusNotFound {
		t.Fatalf("POST after DELETE status = %d, want 404", afterDel.StatusCode)
	}
}

func TestStreamableHTTPValidationAndSSE(t *testing.T) {
	srv := httptest.NewServer(NewHTTPHandler(""))
	defer srv.Close()
	mcpURL := srv.URL + "/mcp"

	// GET /mcp -> 405
	getResp, err := http.Get(mcpURL)
	if err != nil {
		t.Fatal(err)
	}
	getResp.Body.Close()
	if getResp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET /mcp status = %d, want 405", getResp.StatusCode)
	}

	// MCP-Protocol-Version inválida -> 400
	badVer := doMCPPost(t, mcpURL, "", "", "1999-01-01", "", `{"jsonrpc":"2.0","id":1,"method":"ping"}`)
	badVerBytes, _ := io.ReadAll(badVer.Body)
	badVer.Body.Close()
	if badVer.StatusCode != http.StatusBadRequest || !strings.Contains(string(badVerBytes), "UNSUPPORTED_PROTOCOL_VERSION") {
		t.Fatalf("bad protocol version: %d %s", badVer.StatusCode, badVerBytes)
	}

	// JSON inválido -> 400 (-32700)
	badJSON := doMCPPost(t, mcpURL, "", "", "", "", `{broken`)
	badJSONBytes, _ := io.ReadAll(badJSON.Body)
	badJSON.Body.Close()
	if badJSON.StatusCode != http.StatusBadRequest || !strings.Contains(string(badJSONBytes), "-32700") {
		t.Fatalf("bad json: %d %s", badJSON.StatusCode, badJSONBytes)
	}

	// Sessão desconhecida -> 404
	missingSid := doMCPPost(t, mcpURL, "", "does-not-exist", "", "", `{"jsonrpc":"2.0","id":1,"method":"ping"}`)
	missingSid.Body.Close()
	if missingSid.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown session status = %d, want 404", missingSid.StatusCode)
	}

	// Accept apenas text/event-stream -> responde SSE válido
	sseResp := doMCPPost(t, mcpURL, "", "", "", "text/event-stream", `{"jsonrpc":"2.0","id":7,"method":"ping"}`)
	defer sseResp.Body.Close()
	if sseResp.StatusCode != http.StatusOK || !strings.HasPrefix(sseResp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("SSE headers: status=%d ct=%q", sseResp.StatusCode, sseResp.Header.Get("Content-Type"))
	}
	sc := bufio.NewScanner(sseResp.Body)
	var dataLine string
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "data:") {
			dataLine = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			break
		}
	}
	if !strings.Contains(dataLine, `"id":7`) || !strings.Contains(dataLine, `"result":{}`) {
		t.Fatalf("unexpected SSE payload: %q", dataLine)
	}
}
