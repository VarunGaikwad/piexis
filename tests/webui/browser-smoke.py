"""Optional browser regression proof using a disposable, mocked Pi WebSocket.

Install Python Playwright and Chromium outside the repository, then run:
  python skills/webapp-testing/scripts/with_server.py \
    --server "npm exec vite -- --config apps/web/vite.config.ts" --port 5173 \
    -- python tests/webui/browser-smoke.py

No Pi credentials, live models, or backend changes are needed.
"""
import json
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ONE = "00000000-0000-4000-8000-000000000001"
TWO = "00000000-0000-4000-8000-000000000002"
THREE = "00000000-0000-4000-8000-000000000003"


class Runtime:
    def __init__(self):
        self.socket = None
        self.commands = []
        self.sessions = [
            {"id": ONE, "name": "Workspace alpha", "status": "ready", "model": "fixture/model"},
            {"id": TWO, "name": "Workspace beta", "status": "ready", "model": "fixture/model"},
        ]
        self.messages = {
            ONE: [{"role": "assistant", "content": "## Local workspace\n\nA **safe** UI.\n\n- Sessions\n- Activity\n\n```ts\nconst local = true;\n```\n\n<script>window.fixtureUnsafe = true</script>"}],
            TWO: [],
        }

    def send(self, payload):
        self.socket.send(json.dumps(payload))

    def snapshot(self, session_id):
        self.send({"type": "snapshot", "sessionId": session_id, "sessions": self.sessions, "messages": self.messages[session_id], "state": {}})

    def event(self, session_id, event):
        self.send({"type": "pi_event", "sessionId": session_id, "event": event})

    def route(self, socket):
        self.socket = socket
        socket.on_message(self.command)

    def command(self, raw):
        command = json.loads(raw)
        self.commands.append(command)
        kind = command["type"]
        if kind == "list_sessions":
            self.snapshot(ONE)
        elif kind == "create_session":
            self.sessions.append({"id": THREE, "name": "Workspace new", "status": "ready"})
            self.messages[THREE] = []
            self.snapshot(THREE)
        elif kind == "subscribe":
            self.snapshot(command["sessionId"])
        elif kind == "prompt":
            session_id = command["sessionId"]
            for session in self.sessions:
                if session["id"] == session_id:
                    session["status"] = "running"
            self.event(session_id, {"type": "agent_start"})
            message = {"role": "user", "content": command["message"]}
            self.messages[session_id].append(message)
            self.event(session_id, {"type": "message_end", "message": message})
            self.event(session_id, {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "Streaming fixture output"}})
            self.event(session_id, {"type": "tool_execution_start", "toolCallId": "read-1", "toolName": "read", "args": {"path": "example.ts"}})
        elif kind == "abort":
            session_id = command["sessionId"]
            self.event(session_id, {"type": "tool_execution_end", "toolCallId": "read-1", "result": "Fixture file read", "isError": False})
            message = {"role": "assistant", "content": "Stopped safely."}
            self.messages[session_id].append(message)
            self.event(session_id, {"type": "message_end", "message": message})
            self.event(session_id, {"type": "agent_settled", "aborted": True})
            for session in self.sessions:
                if session["id"] == session_id:
                    session["status"] = "ready"
        elif kind == "git_status":
            self.send({"type": "workspace", "sessionId": command["sessionId"], "action": "git_status", "data": {"branch": "fixture-branch", "files": [{"status": "M", "path": "apps/web/example.ts"}]}})


def run():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        runtime = Runtime()
        errors = []
        external_requests = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("request", lambda request: external_requests.append(request.url) if urlparse(request.url).hostname not in {"127.0.0.1", "localhost", None} else None)
        page.route_web_socket("**/ws?token=fixture", runtime.route)
        page.goto("http://127.0.0.1:5173/#token=fixture")
        page.wait_for_load_state("networkidle")
        expect(page.get_by_role("heading", name="Local workspace")).to_be_visible()
        assert page.evaluate("window.fixtureUnsafe") is None
        assert page.locator(".markdown li").count() == 2
        expect(page.locator(".markdown pre code")).to_contain_text("const local")
        page.evaluate("document.fonts.ready")
        loaded_fonts = page.evaluate("Array.from(document.fonts).filter(font => font.status === 'loaded').map(font => font.family)")
        assert "Geist Variable" in loaded_fonts, loaded_fonts
        assert "JetBrains Mono Variable" in loaded_fonts, loaded_fonts
        assert "Geist Variable" in page.locator("body").evaluate("element => getComputedStyle(element).fontFamily")
        assert "JetBrains Mono Variable" in page.locator(".markdown pre code").evaluate("element => getComputedStyle(element).fontFamily")
        for license_path in ["/fonts/Geist-OFL.txt", "/fonts/JetBrainsMono-OFL.txt"]:
            license_response = page.request.get("http://127.0.0.1:5173" + license_path)
            assert license_response.ok
            assert "SIL OPEN FONT LICENSE" in license_response.text()

        # IME Enter must not submit. A duplicate synchronous click submits only once.
        draft = page.get_by_role("textbox", name="Message PIXIS")
        draft.fill("Inspect the local workspace")
        runtime.send({"type": "session", "session": {**runtime.sessions[0], "status": "starting"}})
        expect(page.get_by_role("button", name="Send ↵")).to_be_disabled()
        expect(draft).to_have_value("Inspect the local workspace")
        runtime.send({"type": "session", "session": runtime.sessions[0]})
        expect(page.get_by_role("button", name="Send ↵")).to_be_enabled()
        draft.evaluate("node => node.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', isComposing: true, bubbles: true}))")
        assert not [command for command in runtime.commands if command["type"] == "prompt"]
        page.get_by_role("button", name="Send ↵").evaluate("node => { node.click(); node.click(); }")
        expect(page.get_by_role("button", name="Stop")).to_be_visible()
        expect(page.get_by_text("Streaming fixture output")).to_be_visible()
        assert len([command for command in runtime.commands if command["type"] == "prompt"]) == 1
        expect(draft).to_have_value("")
        draft.fill("Draft while running")
        expect(draft).to_be_enabled()

        # Navigation preserves per-session streaming and tools.
        page.get_by_role("button", name="Workspace beta").click()
        expect(page.get_by_text("Ready when you are.")).to_be_visible()
        page.get_by_role("button", name="Workspace alpha").click()
        expect(page.get_by_text("Streaming fixture output")).to_be_visible()
        expect(draft).to_have_value("Draft while running")
        page.get_by_role("tab", name="ACTIVITY").click()
        expect(page.get_by_text("Running", exact=True)).to_be_visible()
        page.get_by_role("button", name="Stop").click()
        expect(page.get_by_text("Stopped safely.")).to_be_visible()
        expect(page.get_by_text("Done", exact=True)).to_be_visible()
        page.get_by_role("tab", name="GIT", exact=True).click()
        page.get_by_role("button", name="Refresh", exact=True).click()
        expect(page.locator(".branch-name")).to_contain_text("fixture-branch")
        assert page.get_by_role("button", name="apps/web/example.ts").count() == 0

        # Dialog answers always target the session that requested them.
        runtime.send({"type": "extension_ui", "sessionId": TWO, "request": {"id": "pick", "method": "select", "title": "Choose fixture", "options": ["Option A", "Option B"]}})
        page.wait_for_timeout(50)
        assert page.get_by_role("dialog").count() == 0
        page.get_by_role("button", name="Workspace beta").click()
        dialog = page.get_by_role("dialog")
        expect(dialog).to_be_visible()
        page.get_by_role("button", name="Option B", exact=True).click()
        assert runtime.commands[-1] == {"type": "extension_ui_response", "sessionId": TWO, "id": "pick", "value": "Option B"}
        expect(dialog).to_have_count(0)
        runtime.send({"type": "extension_ui", "sessionId": TWO, "request": {"id": "input", "method": "input", "title": "Input fixture", "prefill": "initial"}})
        expect(dialog).to_be_visible()
        page.get_by_role("textbox", name="Response").fill("answer")
        page.get_by_role("button", name="Submit", exact=True).click()
        assert runtime.commands[-1]["value"] == "answer"
        runtime.send({"type": "extension_ui", "sessionId": TWO, "request": {"id": "confirm", "method": "confirm", "title": "Confirm fixture"}})
        expect(dialog).to_be_visible()
        page.keyboard.press("Escape")
        assert runtime.commands[-1]["cancelled"] is True

        # Errors are dismissible, not replaced by another fallback error.
        runtime.send({"type": "error", "message": "Fixture error"})
        expect(page.get_by_role("alert")).to_contain_text("Fixture error")
        page.get_by_role("button", name="Dismiss error").click()
        expect(page.get_by_role("alert")).to_have_count(0)

        # Desktop collapse, tablet access, and mobile keyboard focus restoration.
        page.get_by_role("button", name="Hide sessions").click()
        expect(page.locator(".shell > .left-sidebar")).to_be_hidden()
        page.get_by_role("button", name="Show sessions").click()
        page.get_by_role("button", name="Hide workspace").click()
        expect(page.locator(".shell > .context-sidebar")).to_be_hidden()
        page.get_by_role("button", name="Show workspace").click()
        page.screenshot(path="/tmp/piexis-webui-desktop.png", full_page=True)
        page.set_viewport_size({"width": 900, "height": 900})
        page.get_by_role("button", name="Open workspace").click()
        expect(page.get_by_role("dialog")).to_be_visible()
        page.keyboard.press("Escape")
        expect(page.get_by_role("button", name="Open workspace")).to_be_focused()

        page.set_viewport_size({"width": 390, "height": 844})
        page.get_by_role("button", name="Open sessions").click()
        expect(page.get_by_role("dialog")).to_be_visible()
        for _ in range(12):
            page.keyboard.press("Tab")
            assert page.evaluate("!!document.activeElement.closest('[role=dialog]')")
        page.keyboard.press("Escape")
        expect(page.get_by_role("button", name="Open sessions")).to_be_focused()
        page.get_by_role("button", name="Open workspace").click()
        expect(page.get_by_role("button", name="Close workspace")).to_be_visible()
        page.get_by_role("button", name="Close workspace").click()
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        page.screenshot(path="/tmp/piexis-webui-mobile.png", full_page=True)

        # Creation and disconnected drafting remain honest.
        page.get_by_role("button", name="Open sessions").click()
        page.get_by_role("button", name="+ New session").click()
        expect(page.get_by_role("dialog")).to_have_count(0)
        expect(page.locator(".topbar strong")).to_have_text("Workspace new")
        draft.fill("Keep this draft")
        runtime.socket.close(code=1000, reason="Fixture disconnected")
        expect(page.get_by_role("alert")).to_contain_text("Fixture disconnected")
        expect(draft).to_have_value("Keep this draft")
        expect(draft).to_be_enabled()
        expect(page.get_by_role("button", name="Send ↵")).to_be_disabled()
        for width in [320, 700, 768, 980, 1100, 1440]:
            page.set_viewport_size({"width": width, "height": 700})
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), width
            assert page.locator(".conversation").bounding_box()["width"] > 250, width
        assert not errors, errors
        assert not external_requests, external_requests
        browser.close()
        print("Browser smoke passed: sessions, stream/tools, abort, Git, dialogs, IME, errors, responsive focus, disconnect.")


if __name__ == "__main__":
    run()
