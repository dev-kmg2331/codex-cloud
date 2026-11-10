"""Exercise a deployed demo with a real RTSP source and save test evidence.

RTSP_TEST_URL=rtsp://host/path python scripts/test_rtsp_browser.py
Requires requirements-dev.txt and Playwright Chromium or system Chromium.
"""

import argparse
import json
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from zoneinfo import ZoneInfo

from playwright.sync_api import sync_playwright


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--url", default=os.environ.get("RTSP_TEST_URL"))
    parser.add_argument("--seconds", type=int, choices=range(1, 31), default=15)
    parser.add_argument("--output", type=Path, default=Path("reports/rtsp-browser"))
    args = parser.parse_args()
    if not args.url:
        parser.error("Set RTSP_TEST_URL or pass --url")
    args.output.mkdir(parents=True, exist_ok=True)
    source = urlsplit(args.url)
    # Do not persist authentication information or token query strings.
    host = source.hostname or ""
    if ":" in host:
        host = f"[{host}]"
    authority = host + (f":{source.port}" if source.port else "")
    safe_url = urlunsplit((source.scheme, authority, source.path, "", ""))
    report = {
        "tested_at": datetime.now(ZoneInfo("Asia/Seoul")).isoformat(),
        "base_url": args.base_url,
        "source": safe_url,
        "passed": False,
        "browser_errors": [],
    }
    with sync_playwright() as playwright:
        executable = shutil.which("chromium") or shutil.which("google-chrome")
        browser = playwright.chromium.launch(
            headless=True, executable_path=executable, args=["--no-sandbox"],
        )
        page = browser.new_page(viewport={"width": 1440, "height": 1100}, timezone_id="Asia/Seoul")
        page.on("pageerror", lambda error: report["browser_errors"].append(str(error)))
        try:
            response = page.request.get(args.base_url + "/api/health", timeout=10000)
            report["health"] = {"http_status": response.status, "body": response.json()}
            page.goto(args.base_url, wait_until="networkidle")
            page.wait_for_function(
                "!document.getElementById('toggle-stream').disabled || !document.getElementById('notice').hidden",
                timeout=10000,
            )
            if not page.locator("#toggle-stream").is_enabled():
                raise RuntimeError("WebCodecs is unavailable in this browser context")
            page.locator("#rtsp-url").fill(args.url)
            page.locator("#toggle-stream").click()
            page.wait_for_function(
                "Number(document.getElementById('metric-frames').textContent.replaceAll(',', '')) >= 30 || !document.getElementById('notice').hidden",
                timeout=25000,
            )
            if page.locator("#notice").is_visible():
                report["error"] = page.locator("#notice").inner_text()
            else:
                start_frames = int(page.locator("#metric-frames").inner_text().replace(",", ""))
                page.wait_for_timeout(args.seconds * 1000)
                end_frames = int(page.locator("#metric-frames").inner_text().replace(",", ""))
                report["observation_seconds"] = args.seconds
                report["frames_during_observation"] = end_frames - start_frames
                report["observed_fps"] = round((end_frames - start_frames) / args.seconds, 2)
                report["passed"] = (
                    end_frames > start_frames
                    and page.locator("#stream-status").inner_text() == "스트리밍 중"
                    and not report["browser_errors"]
                )
                if not report["passed"]:
                    report["error"] = "Playback stopped or no frames advanced during observation"
            report["stream_status"] = page.locator("#stream-status").inner_text()
            report["frames_total"] = page.locator("#metric-frames").inner_text()
            report["resolution"] = page.locator("#source-resolution").inner_text()
            report["source_fps"] = page.locator("#source-fps").inner_text()
            report["logs"] = page.locator("#logs").inner_text().splitlines()
        except Exception as error:
            report["error"] = str(error).replace(args.url, safe_url)
        finally:
            # Hide the editable URL before capturing potential camera credentials.
            if page.locator("#rtsp-url").count():
                page.locator("#rtsp-url").evaluate("node => { node.value = '(RTSP 주소 숨김)'; }")
            page.screenshot(path=str(args.output / "browser.png"), full_page=True)
            if page.locator("#button-text").count() and page.locator("#button-text").inner_text() == "스트리밍 중지":
                page.locator("#toggle-stream").click()
            browser.close()
    destination = args.output / "result.json"
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"Report: {destination.resolve()}")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
