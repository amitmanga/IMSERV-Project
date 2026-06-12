from pathlib import Path
import shutil
import sys
import time

from playwright.sync_api import sync_playwright


BASE_URL = "http://127.0.0.1:5000"
TARGET_SECONDS = 180
WIDTH, HEIGHT = 1280, 720
WORKSPACE = Path(__file__).resolve().parents[1]
OUT_DIR = WORKSPACE / "demo"
RAW_DIR = OUT_DIR / "raw-video"
FINAL_VIDEO = OUT_DIR / "IMSERV_app_demo_3min.webm"


def ensure_inside(path: Path, root: Path) -> None:
    resolved = path.resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError as exc:
        raise RuntimeError(f"Refusing to touch path outside workspace: {resolved}") from exc


def prepare_dirs() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ensure_inside(OUT_DIR, WORKSPACE)
    ensure_inside(RAW_DIR, WORKSPACE)
    ensure_inside(FINAL_VIDEO, WORKSPACE)
    if RAW_DIR.exists():
        shutil.rmtree(RAW_DIR)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    if FINAL_VIDEO.exists():
        FINAL_VIDEO.unlink()


def inject_demo_ui(page) -> None:
    page.add_style_tag(
        content=r"""
      #demo-caption {
        position: fixed;
        left: 238px;
        right: 24px;
        bottom: 18px;
        z-index: 2147483600;
        display: flex;
        align-items: center;
        gap: 14px;
        min-height: 68px;
        padding: 14px 18px;
        color: #fff;
        background: rgba(18, 24, 38, 0.92);
        border-left: 5px solid #ff6b1a;
        border-radius: 8px;
        box-shadow: 0 16px 40px rgba(8, 15, 30, 0.22);
        font-family: Inter, Arial, sans-serif;
        pointer-events: none;
        backdrop-filter: blur(10px);
      }
      #demo-caption .demo-step {
        min-width: 54px;
        height: 38px;
        display: grid;
        place-items: center;
        border: 1px solid rgba(255, 255, 255, 0.28);
        border-radius: 7px;
        color: #ffd6bf;
        font-weight: 800;
        font-size: 15px;
      }
      #demo-caption .demo-title {
        font-size: 20px;
        line-height: 1.1;
        font-weight: 800;
        letter-spacing: 0;
      }
      #demo-caption .demo-subtitle {
        margin-top: 5px;
        font-size: 13px;
        line-height: 1.35;
        color: rgba(255, 255, 255, 0.82);
        max-width: 830px;
      }
      #demo-cursor {
        position: fixed;
        left: 32px;
        top: 32px;
        width: 22px;
        height: 22px;
        z-index: 2147483640;
        pointer-events: none;
        border-radius: 999px;
        border: 3px solid #ff6b1a;
        background: rgba(255, 255, 255, 0.7);
        box-shadow: 0 0 0 7px rgba(255, 107, 26, 0.16), 0 8px 18px rgba(0,0,0,0.24);
        transform: translate(-50%, -50%);
        transition: left 420ms cubic-bezier(.2,.8,.2,1), top 420ms cubic-bezier(.2,.8,.2,1), transform 160ms ease;
      }
      #demo-cursor.demo-pulse {
        transform: translate(-50%, -50%) scale(0.72);
      }
      .demo-highlight {
        position: relative !important;
        z-index: 2147483000 !important;
        box-shadow: 0 0 0 3px rgba(255, 107, 26, 0.82), 0 0 0 9px rgba(255, 107, 26, 0.14) !important;
        border-radius: 8px !important;
        transition: box-shadow 240ms ease !important;
      }
      body.demo-recording * { scroll-behavior: smooth !important; }
    """
    )
    page.evaluate(
        r"""
      () => {
        document.body.classList.add('demo-recording');
        if (!document.getElementById('demo-caption')) {
          const caption = document.createElement('div');
          caption.id = 'demo-caption';
          caption.innerHTML = '<div class="demo-step">01</div><div><div class="demo-title"></div><div class="demo-subtitle"></div></div>';
          document.body.appendChild(caption);
        }
        if (!document.getElementById('demo-cursor')) {
          const cursor = document.createElement('div');
          cursor.id = 'demo-cursor';
          document.body.appendChild(cursor);
        }
        window.__demo = {
          caption(step, title, subtitle) {
            const el = document.getElementById('demo-caption');
            el.querySelector('.demo-step').textContent = step;
            el.querySelector('.demo-title').textContent = title;
            el.querySelector('.demo-subtitle').textContent = subtitle;
          },
          moveCursor(x, y) {
            const c = document.getElementById('demo-cursor');
            c.style.left = `${Math.round(x)}px`;
            c.style.top = `${Math.round(y)}px`;
          },
          pulseCursor() {
            const c = document.getElementById('demo-cursor');
            c.classList.add('demo-pulse');
            setTimeout(() => c.classList.remove('demo-pulse'), 180);
          },
          clearHighlight() {
            document.querySelectorAll('.demo-highlight').forEach(el => el.classList.remove('demo-highlight'));
          },
          highlight(selector) {
            this.clearHighlight();
            const el = document.querySelector(selector);
            if (el) el.classList.add('demo-highlight');
          },
          scrollToSelector(selector, block='center') {
            const el = document.querySelector(selector);
            if (el) el.scrollIntoView({ behavior: 'smooth', block, inline: 'nearest' });
          },
          scrollToTop() {
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }
        };
      }
    """
    )


def caption(page, step: str, title: str, subtitle: str) -> None:
    page.evaluate(
        "([step, title, subtitle]) => window.__demo.caption(step, title, subtitle)",
        [step, title, subtitle],
    )


def highlight(page, selector: str) -> None:
    page.evaluate("selector => window.__demo.highlight(selector)", selector)


def clear_highlight(page) -> None:
    page.evaluate("() => window.__demo.clearHighlight()")


def pause(page, seconds: float) -> None:
    page.wait_for_timeout(int(seconds * 1000))


def scroll_to(page, selector: str, block: str = "center", seconds: float = 1.0) -> None:
    page.evaluate(
        "([selector, block]) => window.__demo.scrollToSelector(selector, block)",
        [selector, block],
    )
    pause(page, seconds)


def scroll_top(page, seconds: float = 0.9) -> None:
    page.evaluate("() => window.__demo.scrollToTop()")
    pause(page, seconds)


def move_cursor_to(page, selector: str, x_offset: float = 0, y_offset: float = 0) -> None:
    locator = page.locator(selector).first
    box = locator.bounding_box()
    if not box:
        return
    x = box["x"] + box["width"] / 2 + x_offset
    y = box["y"] + box["height"] / 2 + y_offset
    page.evaluate("([x, y]) => window.__demo.moveCursor(x, y)", [x, y])
    pause(page, 0.45)


def click_with_cursor(page, selector: str) -> None:
    move_cursor_to(page, selector)
    page.evaluate("() => window.__demo.pulseCursor()")
    page.click(selector)
    pause(page, 0.35)


def wait_for_journey(page) -> None:
    page.wait_for_function(
        "document.querySelector('#kpi-total-requests') && !document.querySelector('#kpi-total-requests').textContent.includes('—')"
    )


def wait_for_timeslot(page) -> None:
    page.wait_for_function(
        "document.querySelector('#view-timeslot .kpi-value') && !document.querySelector('#view-timeslot .kpi-value').textContent.includes('—')"
    )


def wait_for_cancellations(page) -> None:
    page.wait_for_function(
        "document.querySelector('#view-cancellations .kpi-value') && !document.querySelector('#view-cancellations .kpi-value').textContent.includes('—')"
    )


def wait_for_roster(page) -> None:
    page.wait_for_function("document.querySelectorAll('#pt-lbody tr').length > 1")


def wait_for_longterm(page) -> None:
    page.wait_for_selector("#pstab-longterm.pst-panel--active", state="visible")
    page.wait_for_selector("#lt-trend-chart", state="visible")
    pause(page, 5.5)


def wait_for_financial(page) -> None:
    page.wait_for_function(
        "document.querySelector('#fin-kpi-revenue') && !document.querySelector('#fin-kpi-revenue').textContent.includes('—')"
    )


def switch_view(page, view: str, wait_selector: str) -> None:
    selector = f'.nav-item[data-view="{view}"]'
    scroll_top(page, 0.5)
    highlight(page, selector)
    click_with_cursor(page, selector)
    page.wait_for_selector(wait_selector, state="visible")
    clear_highlight(page)


def record_demo() -> Path:
    prepare_dirs()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=[f"--window-size={WIDTH},{HEIGHT}"])
        context = browser.new_context(
            viewport={"width": WIDTH, "height": HEIGHT},
            device_scale_factor=1,
            record_video_dir=str(RAW_DIR),
            record_video_size={"width": WIDTH, "height": HEIGHT},
        )
        page = context.new_page()
        page.set_default_timeout(45000)
        started = time.time()
        try:
            page.goto(BASE_URL, wait_until="load")
            page.wait_for_selector("#page-title", state="visible")
            wait_for_journey(page)
            inject_demo_ui(page)

            caption(
                page,
                "01",
                "IMSERV Smart Meter Operations Platform",
                "A three-minute walkthrough of appointment performance, recovery risk, resource planning, meter lookup, and financial scenario impact.",
            )
            highlight(page, ".sidebar-brand")
            pause(page, 5.5)
            clear_highlight(page)

            caption(
                page,
                "02",
                "Appointment journey overview",
                "The opening dashboard gives leaders the full funnel: customer requests, dialler load, contacts, bookings, cancellations, aborts, and completed work.",
            )
            highlight(page, "#journey-kpis")
            pause(page, 8)
            scroll_to(page, "#journey-trend-chart", "center", 1.1)
            highlight(page, "#journey-trend-chart")
            pause(page, 5)
            scroll_to(page, "#regional-heatmap-grid", "center", 1.1)
            highlight(page, "#regional-heatmap-grid")
            pause(page, 4)

            caption(
                page,
                "03",
                "Regional filtering",
                "Global filters let the same story collapse from national performance into a selected region for local operational reviews.",
            )
            scroll_top(page, 0.9)
            highlight(page, "#global-region")
            move_cursor_to(page, "#global-region")
            page.select_option("#global-region", "NW")
            page.evaluate("() => window.__demo.pulseCursor()")
            pause(page, 3.4)
            page.select_option("#global-region", "")
            pause(page, 1.8)
            clear_highlight(page)

            caption(
                page,
                "04",
                "Dialler performance",
                "Move from appointments into dialler productivity, where booking conversion, executed work, best call windows, and business-category patterns are visible together.",
            )
            switch_view(page, "timeslot", "#view-timeslot")
            wait_for_timeslot(page)
            highlight(page, "#view-timeslot .kpi-grid")
            pause(page, 5)
            scroll_to(page, "#view-timeslot .card", "start", 1.1)
            highlight(page, "#view-timeslot .card")
            pause(page, 6)

            caption(
                page,
                "05",
                "Risk and recovery",
                "The recovery view separates D-1 cancellations from same-day aborts, then ranks the root causes that drive appointment fallout.",
            )
            switch_view(page, "cancellations", "#view-cancellations")
            wait_for_cancellations(page)
            highlight(page, "#view-cancellations .kpi-grid")
            pause(page, 5)
            highlight(page, "#view-cancellations")
            pause(page, 8)

            caption(
                page,
                "06",
                "Short-term resource planning",
                "Planning starts with a roster matrix: engineer coverage by region, date, and slot, including utilisation bands and remaining capacity.",
            )
            switch_view(page, "field-ops", "#view-field-ops")
            wait_for_roster(page)
            highlight(page, "#pstab-shortterm .pt-outer")
            pause(page, 7)
            scroll_to(page, "#pstab-shortterm .pt-outer", "center", 0.8)
            page.mouse.wheel(420, 0)
            pause(page, 3)

            caption(
                page,
                "07",
                "Long-term capacity forecast",
                "The long-term tab turns daily capacity into a twelve-month demand, capacity, utilisation, and demand-gap forecast.",
            )
            scroll_top(page, 0.7)
            highlight(page, '#view-field-ops .pst-btn[data-tab="longterm"]')
            click_with_cursor(page, '#view-field-ops .pst-btn[data-tab="longterm"]')
            wait_for_longterm(page)
            highlight(page, "#lt-kpi-strip")
            pause(page, 4)
            scroll_to(page, "#pstab-longterm .lt-card-trend", "center", 1.0)
            highlight(page, "#pstab-longterm .lt-card-trend")
            pause(page, 5)

            caption(
                page,
                "08",
                "Single meter view",
                "Customer-facing teams can enter an MPXN and bring meter details, MOP/DC status, visit history, and dialler contact context into one page.",
            )
            switch_view(page, "meterview", "#view-meterview")
            highlight(page, ".mv-hero-card")
            move_cursor_to(page, "#mv-mpxn-input")
            page.fill("#mv-mpxn-input", "3110000000700")
            pause(page, 1)
            click_with_cursor(page, ".mv-search-btn")
            page.wait_for_selector("#mv-meter-details .mv-field-row", state="visible")
            pause(page, 2.5)
            highlight(page, ".mv-panels-grid")
            pause(page, 7)
            scroll_to(page, ".mv-history-card", "center", 1.0)
            highlight(page, ".mv-history-card")
            pause(page, 4)

            caption(
                page,
                "09",
                "Financial scenario impact",
                "Finance can test appointment volumes, success rates, cancellation pressure, cost change, and engineer capacity, then read the P&L effect immediately.",
            )
            switch_view(page, "financial", "#view-financial")
            wait_for_financial(page)
            highlight(page, "#fin-kpis")
            pause(page, 4)
            scroll_to(page, ".scenario-input-grid", "center", 0.8)
            highlight(page, ".scenario-input-grid")
            page.fill("#sc-name", "Demo Margin Recovery")
            page.fill("#sc-volume", "195000")
            page.eval_on_selector(
                "#sc-completion",
                "el => { el.value = '72'; el.dispatchEvent(new Event('input', { bubbles: true })); }",
            )
            page.eval_on_selector(
                "#sc-cancel",
                "el => { el.value = '10'; el.dispatchEvent(new Event('input', { bubbles: true })); }",
            )
            page.eval_on_selector(
                "#sc-cost-uplift",
                "el => { el.value = '-4'; el.dispatchEvent(new Event('input', { bubbles: true })); }",
            )
            pause(page, 3)
            click_with_cursor(page, "#view-financial .card-actions .btn-primary")
            page.wait_for_selector("#scenario-results", state="visible")
            pause(page, 1.5)
            scroll_to(page, "#scenario-results", "center", 0.9)
            highlight(page, "#scenario-results")
            pause(page, 8)

            caption(
                page,
                "10",
                "End-to-end operating rhythm",
                "The demo connects performance monitoring, recovery prioritisation, capacity planning, customer lookup, and financial trade-offs in one workflow.",
            )
            clear_highlight(page)
            elapsed = time.time() - started
            pause(page, max(2, TARGET_SECONDS - elapsed))
        finally:
            context.close()
            browser.close()

    videos = sorted(RAW_DIR.glob("*.webm"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not videos:
        raise RuntimeError("Playwright did not produce a video file")
    shutil.move(str(videos[0]), str(FINAL_VIDEO))
    return FINAL_VIDEO


if __name__ == "__main__":
    try:
        final = record_demo()
        size_mb = final.stat().st_size / (1024 * 1024)
        print(f"VIDEO={final}")
        print(f"SIZE_MB={size_mb:.2f}")
    except Exception as exc:
        print(f"ERROR={type(exc).__name__}: {exc}", file=sys.stderr)
        raise
