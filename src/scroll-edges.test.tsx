// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useScrollEdges } from "./scroll-edges";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("native scroll continuation edges", () => {
  it("tracks individual panes without a label row, and cleans up its decoration", () => {
    let resized = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resized = callback; }
      observe() {} disconnect = disconnect;
    });
    function Fixture({ enabled = true }) {
      const ref = useRef<HTMLDivElement>(null);
      useScrollEdges(ref, enabled);
      return <div ref={enabled ? ref : undefined}><div data-testid="pane" style={{ overflowY: "auto", border: 0 }}>Content</div><div data-testid="fitting" style={{ overflowY: "auto" }}>Other content</div></div>;
    }
    const { container, rerender } = render(<Fixture />);
    const pane = screen.getByTestId("pane");
    const metrics = { height: 200, gutter: 0 };
    Object.defineProperties(pane, { clientHeight: { get: () => metrics.height }, scrollHeight: { value: 600 }, clientWidth: { value: 200 }, offsetWidth: { get: () => 200 + metrics.gutter }, getClientRects: { value: () => [{ height: 200 }] } });
    act(() => resized());
    expect(pane.dataset.scrollEdges).toBe("below");
    expect(pane.dataset.overlayScroll).toBe("true");
    expect(screen.getByTestId("fitting").dataset.scrollEdges).toBe("none");
    expect(container.textContent).toBe("ContentOther content");
    pane.scrollTop = 100; fireEvent.scroll(pane);
    expect(pane.dataset.scrollEdges).toBe("both");
    pane.scrollTop = 400; fireEvent.scroll(pane);
    expect(pane.dataset.scrollEdges).toBe("above");
    metrics.gutter = 14; act(() => resized());
    expect(pane.dataset.overlayScroll).toBe("false");
    pane.scrollTop = 0; metrics.height = 700; act(() => resized());
    expect(pane.dataset.scrollEdges).toBe("none");
    rerender(<Fixture enabled={false} />);
    expect(pane.hasAttribute("data-scroll-edges")).toBe(false);
    expect(disconnect).toHaveBeenCalled();
  });

  it("discovers late-mounted content and follows visibility changes", async () => {
    function Fixture({ shown }: { shown: boolean }) {
      const ref = useRef<HTMLDivElement>(null);
      useScrollEdges(ref);
      return <div ref={ref}>{shown ? <section data-testid="late" style={{ overflowY: "auto" }}>Loaded page</section> : null}</div>;
    }
    const { rerender } = render(<Fixture shown={false} />);
    rerender(<Fixture shown />);
    const pane = screen.getByTestId("late");
    Object.defineProperties(pane, { clientHeight: { value: 100 }, scrollHeight: { value: 300 }, getClientRects: { value: () => pane.hidden ? [] : [{}] } });
    await act(async () => {});
    expect(pane.dataset.scrollEdges).toBe("below");
    await act(async () => { pane.hidden = true; });
    expect(pane.dataset.scrollEdges).toBe("none");
  });
});
