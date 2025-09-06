import { NextRequest, NextResponse } from "next/server";
import { chromium } from "playwright";

// In-memory store for session data (replace with Redis in production)
const sessionData: { [sessionId: string]: { text: string; tag: string }[] } = {};

// Extend Window interface for custom properties
interface CustomWindow extends Window {
  geminiLastHighlighted: HTMLElement | null;
  geminiOriginalBorder: string | null;
  geminiOriginalCursor: string | null;
  onMouseOver?: (e: MouseEvent) => void;
  onMouseOut?: (e: MouseEvent) => void;
  onClick?: (e: MouseEvent) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  sendSelectedData: (elements: { text: string; tag: string }[]) => void;
  setEscapePressed: () => void;
  setEnterPressed: () => void; // Added for completeness
}

export async function POST(req: NextRequest) {
  let browser: import("playwright").Browser | null = null;
  try {
    const { url } = await req.json();
    if (!url) return NextResponse.json({ error: "URL is required" }, { status: 400 });

    const validatedUrl = url.startsWith("http") ? url : `https://${url}`;
    const sessionId = Date.now().toString(); // Unique session ID
    console.log(`Attempting to launch browser and navigate to: ${validatedUrl}, sessionId: ${sessionId}`);

    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Initialize session data
    sessionData[sessionId] = [];

    // Expose function to receive selected elements
    await page.exposeFunction("sendSelectedData", async (elements: { text: string; tag: string }[]) => {
      console.log("Received elements:", elements);
      sessionData[sessionId] = [...sessionData[sessionId], ...elements];
      console.log("Current sessionData:", sessionData[sessionId]);
    });

    // Expose function to set escape flag
    await page.exposeFunction("setEscapePressed", () => {
      console.log("Escape key detected, setting escapePressed");
    });

    // Expose function to set enter flag (for completeness, though not used for session termination)
    await page.exposeFunction("setEnterPressed", () => {
      console.log("Enter key detected, setting enterPressed");
    });

    // Inject Mouse Mode script
    const injectMouseMode = async () => {
      await page.evaluate(() => {
        const win = window as CustomWindow;

        // Cleanup function to remove listeners and reset styles
        const cleanup = (preserveSelected: boolean = true) => {
          console.log("Cleaning up event listeners and styles, preserveSelected:", preserveSelected);
          if (win.onMouseOver) document.removeEventListener("mouseover", win.onMouseOver);
          if (win.onMouseOut) document.removeEventListener("mouseout", win.onMouseOut);
          if (win.onClick) document.removeEventListener("click", win.onClick);
          if (win.onKeyDown) document.removeEventListener("keydown", win.onKeyDown);

          if (!preserveSelected) {
            document.querySelectorAll(".gemini-selected-element").forEach(el => {
              el.style.removeProperty("border");
              el.classList.remove("gemini-selected-element");
            });
          }

          if (win.geminiLastHighlighted) {
            if (win.geminiOriginalBorder) win.geminiLastHighlighted.style.border = win.geminiOriginalBorder;
            else win.geminiLastHighlighted.style.removeProperty("border");
            if (win.geminiOriginalCursor) win.geminiLastHighlighted.style.cursor = win.geminiOriginalCursor;
            else win.geminiLastHighlighted.style.removeProperty("cursor");
          }

          win.geminiLastHighlighted = null;
          win.geminiOriginalBorder = null;
          win.geminiOriginalCursor = null;
          win.onMouseOver = undefined;
          win.onMouseOut = undefined;
          win.onClick = undefined;
          win.onKeyDown = undefined;
        };

        // Only cleanup if not initial page
        if (win.onMouseOver) {
          console.log("Not initial page, performing cleanup");
          cleanup(true); // Preserve selected elements
        }

        // Initialize global variables
        win.geminiLastHighlighted = null;
        win.geminiOriginalBorder = null;
        win.geminiOriginalCursor = null;

        const highlightStyle = "3px dashed #ff0000";
        const selectedStyle = "3px solid #0066ff";

        const onMouseOver = (e: MouseEvent) => {
          const target = e.target as HTMLElement;
          if (!target || target === document.body || target.classList.contains("gemini-selected-element")) return;

          if (win.geminiLastHighlighted && win.geminiLastHighlighted !== target) {
            if (win.geminiOriginalBorder) win.geminiLastHighlighted.style.border = win.geminiOriginalBorder;
            else win.geminiLastHighlighted.style.removeProperty("border");
            if (win.geminiOriginalCursor) win.geminiLastHighlighted.style.cursor = win.geminiOriginalCursor;
            else win.geminiLastHighlighted.style.removeProperty("cursor");
          }

          win.geminiLastHighlighted = target;
          win.geminiOriginalBorder = target.style.border;
          win.geminiOriginalCursor = target.style.cursor;
          target.style.border = highlightStyle;
          target.style.cursor = "crosshair";
          console.log("Mouse over:", target.tagName);
        };

        const onMouseOut = (e: MouseEvent) => {
          const target = e.target as HTMLElement;
          if (target === win.geminiLastHighlighted && !target.classList.contains("gemini-selected-element")) {
            if (win.geminiOriginalBorder) target.style.border = win.geminiOriginalBorder;
            else target.style.removeProperty("border");
            if (win.geminiOriginalCursor) target.style.cursor = win.geminiOriginalCursor;
            else win.geminiLastHighlighted.style.removeProperty("cursor");
            win.geminiLastHighlighted = null;
            win.geminiOriginalBorder = null;
            win.geminiOriginalCursor = null;
            console.log("Mouse out:", target.tagName);
          }
        };

        const onClick = (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          const target = e.target as HTMLElement;
          if (!target || target === document.body || target.classList.contains("gemini-selected-element")) return;

          const tag = target.tagName.toLowerCase();
          let text = target.innerText.trim();
          if (tag === "img") {
            text = target.getAttribute("src") || "";
          } else if (tag === "a") {
            text = target.getAttribute("href") || text;
          }

          target.style.border = selectedStyle;
          target.classList.add("gemini-selected-element");
          console.log("Element selected:", tag, text);

          if (win.geminiLastHighlighted === target) {
            win.geminiLastHighlighted = null;
            win.geminiOriginalBorder = null;
            win.geminiOriginalCursor = null;
          }

          // Immediately send selected element to backend
          win.sendSelectedData([{ text, tag }]);
        };

        const onKeyDown = (e: KeyboardEvent) => {
          if (e.key === "Enter") {
            console.log("Enter pressed, resetting styles");
            // Reset styles for current page
            document.querySelectorAll(".gemini-selected-element").forEach(el => {
              el.style.removeProperty("border");
              el.classList.remove("gemini-selected-element");
            });
            cleanup(true); // Preserve session
            // Notify frontend to update UI
            win.sendSelectedData([]); // Empty array to signal UI update
          } else if (e.key === "Escape") {
            console.log("Escape pressed, finalizing session");
            cleanup(false);
            win.sendSelectedData([]);
            win.setEscapePressed();
          }
        };

        // Store event listeners in window
        win.onMouseOver = onMouseOver;
        win.onMouseOut = onMouseOut;
        win.onClick = onClick;
        win.onKeyDown = onKeyDown;

        document.addEventListener("mouseover", onMouseOver);
        document.addEventListener("mouseout", onMouseOut);
        document.addEventListener("click", onClick);
        document.addEventListener("keydown", onKeyDown);

        // MutationObserver for SPA navigation
        const observer = new MutationObserver((mutations) => {
          if (mutations.some(m => m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
            console.log("Significant DOM change detected, re-injecting mouse mode");
            cleanup(true); // Preserve selected elements
            win.onMouseOver = onMouseOver;
            win.onMouseOut = onMouseOut;
            win.onClick = onClick;
            win.onKeyDown = onKeyDown;
            document.addEventListener("mouseover", onMouseOver);
            document.addEventListener("mouseout", onMouseOut);
            document.addEventListener("click", onClick);
            document.addEventListener("keydown", onKeyDown);
          }
        });

        observer.observe(document.body, { childList: true, subtree: true });
      });
    };

    // Navigate initial page
    try {
      console.log(`Navigating to ${validatedUrl}`);
      await page.goto(validatedUrl, { waitUntil: "load", timeout: 30000 });
      console.log("Page loaded successfully");
      await injectMouseMode();
    } catch (err) {
      console.error("Navigation failed:", err);
      if (browser) await browser.close();
      return NextResponse.json({ error: "Failed to load URL", detail: (err as Error).message }, { status: 500 });
    }

    // Handle navigation with error handling
    page.on("framenavigated", async (frame) => {
      const frameUrl = frame.url();
      // Skip irrelevant navigations
      if (
        frameUrl.includes("about:blank") ||
        frameUrl.includes("googletagmanager") ||
        frameUrl.includes("web-pixel") ||
        frameUrl.startsWith("file://")
      ) {
        console.log(`Skipping irrelevant navigation to ${frameUrl}`);
        return;
      }

      try {
        console.log(`Navigation detected to ${frameUrl}, cleaning up and re-injecting script`);
        await page.evaluate(() => {
          const win = window as CustomWindow;
          if (win.geminiLastHighlighted) {
            if (win.geminiOriginalBorder) win.geminiLastHighlighted.style.border = win.geminiOriginalBorder;
            else win.geminiLastHighlighted.style.removeProperty("border");
            if (win.geminiOriginalCursor) win.geminiLastHighlighted.style.cursor = win.geminiOriginalCursor;
            else win.geminiLastHighlighted.style.removeProperty("cursor");
          }
          win.geminiLastHighlighted = null;
          win.geminiOriginalBorder = null;
          win.geminiOriginalCursor = null;
        });
        await injectMouseMode();
      } catch (err) {
        console.error(`Error during navigation handling to ${frameUrl}:`, err);
        if (err instanceof Error && err.message.includes("ERR_INVALID_FILE_URL_PATH")) {
          console.log(`Skipping invalid file URL: ${frameUrl}`);
          return; // Explicitly return to avoid unhandled rejection
        }
        console.error("Unhandled navigation error:", err);
        // Continue without throwing to prevent session crash
      }
    });

    // Wait for user to press Escape to finalize
    let escapePressed = false;
    await page.exposeFunction("setEscapePressed", () => {
      escapePressed = true;
    });

    // Note: setEnterPressed is exposed but not used for session termination
    while (!escapePressed) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log("Escape pressed, final sessionData:", sessionData[sessionId]);
    const selectedElements = sessionData[sessionId];
    delete sessionData[sessionId]; // Clean up session data
    if (browser) await browser.close();
    return NextResponse.json({ selectedElements, sessionId });
  } catch (err) {
    console.error("Mouse Mode failed:", err);
    if (browser) await browser.close();
    return NextResponse.json({ error: "Mouse Mode failed", detail: (err as Error).message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const sessionId = req.nextUrl.searchParams.get("sessionId") || "default";
    const selectedElements = sessionData[sessionId] || [];
    console.log(`Returning sessionData for sessionId ${sessionId}:`, selectedElements);
    return NextResponse.json({ selectedElements });
  } catch (err) {
    console.error("Mouse Mode update failed:", err);
    return NextResponse.json({ error: "Failed to fetch updates", detail: (err as Error).message }, { status: 500 });
  }
}