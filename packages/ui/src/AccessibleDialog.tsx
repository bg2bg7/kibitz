import {
  useEffect,
  useRef,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

// eslint-disable-next-line react-refresh/only-export-components
export const FOCUSABLE_ELEMENT_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "object",
  "embed",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

export interface FocusableElementLike {
  focus: (options?: FocusOptions) => void;
  tabIndex?: number;
  isConnected?: boolean;
  hasAttribute?: (name: string) => boolean;
  closest?: (selector: string) => unknown;
}

export interface FocusTrapContainerLike extends FocusableElementLike {
  querySelectorAll(selector: string): ArrayLike<FocusableElementLike>;
  contains?(target: Node | FocusableElementLike | null): boolean;
}

export interface DialogKeyEventLike {
  key: string;
  shiftKey?: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
  stopImmediatePropagation?: () => void;
}

export interface AccessibleDialogProps {
  /** Controls whether the modal dialog is open and mounted. */
  open: boolean;
  /** Invoked when the user requests closing via Escape or backdrop click. */
  onClose: () => void;
  /** ID of the heading element labelling this dialog (`aria-labelledby`). */
  ariaLabelledBy?: string;
  /** Optional ID of the element describing this dialog (`aria-describedby`). */
  ariaDescribedBy?: string;
  /** Optional accessible label used when `ariaLabelledBy` is not provided. */
  ariaLabel?: string;
  /** Whether clicking directly on the backdrop overlay closes the dialog. Defaults to `true`. */
  closeOnBackdropClick?: boolean;
  /** Optional ref to focus initially on open instead of the first focusable element. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Optional class name applied to the dialog panel (merged with `panelClassName`). */
  className?: string;
  /** Optional class name applied to the dialog panel. */
  panelClassName?: string;
  /** Optional class name applied to the backdrop overlay container. */
  overlayClassName?: string;
  /** Optional inline styles applied to the backdrop overlay container. */
  style?: CSSProperties;
  /** Optional inline styles applied to the dialog panel. */
  panelStyle?: CSSProperties;
  /** Optional `data-testid` applied to the dialog panel. */
  testId?: string;
  children: ReactNode;
}

const DEFAULT_OVERLAY_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 100,
  display: "flex",
  minHeight: "100dvh",
  alignItems: "center",
  justifyContent: "center",
  overflowY: "auto",
  backgroundColor: "rgba(2, 6, 23, 0.45)",
  padding: "1rem",
  backdropFilter: "blur(2px)",
};

const openDialogStack: symbol[] = [];

function isElementVisibleForFocus(el: FocusableElementLike): boolean {
  if (el.hasAttribute?.("disabled") || el.hasAttribute?.("hidden")) {
    return false;
  }
  if (typeof el.tabIndex === "number" && el.tabIndex < 0) {
    return false;
  }
  if (el.closest && el.closest("[hidden], [inert]") !== null) {
    return false;
  }
  if (
    typeof window !== "undefined" &&
    typeof Element !== "undefined" &&
    el instanceof Element
  ) {
    const computed = window.getComputedStyle(el);
    if (computed.display === "none" || computed.visibility === "hidden") {
      return false;
    }
  }
  return typeof el.focus === "function";
}

/**
 * Returns focusable descendant elements inside a dialog container in DOM tab order.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function getFocusableElements(
  container: FocusTrapContainerLike | null | undefined,
): FocusableElementLike[] {
  if (!container) return [];
  const candidates = Array.from(container.querySelectorAll(FOCUSABLE_ELEMENT_SELECTOR));
  return candidates.filter((el) => isElementVisibleForFocus(el));
}

/**
 * Moves initial focus inside the dialog panel to `preferredTarget` (if focusable),
 * otherwise the first focusable descendant, or finally the dialog panel itself (`tabIndex={-1}`).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function focusInitialDialogElement(
  panel: FocusTrapContainerLike | null | undefined,
  preferredTarget?: FocusableElementLike | null,
): FocusableElementLike | null {
  if (!panel) return null;
  if (preferredTarget && isElementVisibleForFocus(preferredTarget)) {
    preferredTarget.focus();
    return preferredTarget;
  }
  const focusables = getFocusableElements(panel);
  const target = focusables[0] ?? panel;
  target.focus();
  return target;
}

/**
 * Restores focus to a previously focused element if it is still connected in the DOM.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function restoreDialogFocus(previous: FocusableElementLike | null | undefined): boolean {
  if (!previous || typeof previous.focus !== "function") {
    return false;
  }
  if (previous.isConnected === false) {
    return false;
  }
  previous.focus();
  return true;
}

/**
 * Traps `Tab` and `Shift+Tab` keyboard focus inside `panel`, wrapping cleanly from
 * last->first and first->last (or focusing `panel` itself when no focusable children exist).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function trapFocusInDialog(
  panel: FocusTrapContainerLike,
  event: DialogKeyEventLike,
  activeElement: FocusableElementLike | null | undefined,
): FocusableElementLike | null {
  if (event.key !== "Tab") {
    return null;
  }

  const focusables = getFocusableElements(panel);
  if (focusables.length === 0) {
    event.preventDefault();
    panel.focus();
    return panel;
  }

  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const isInside =
    activeElement != null &&
    (activeElement === panel ||
      (typeof panel.contains === "function"
        ? panel.contains(activeElement)
        : focusables.includes(activeElement)));

  if (event.shiftKey) {
    if (!isInside || activeElement === first || activeElement === panel) {
      event.preventDefault();
      last.focus();
      return last;
    }
    return null;
  }

  if (!isInside || activeElement === last) {
    event.preventDefault();
    first.focus();
    return first;
  }

  return null;
}

/**
 * Processes `Escape` (closing the dialog and stopping propagation so background shortcuts do not fire)
 * and `Tab` / `Shift+Tab` focus trapping for an active dialog panel.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function handleDialogKeyDown(
  event: DialogKeyEventLike,
  options: {
    panel: FocusTrapContainerLike | null;
    onClose: () => void;
    activeElement: FocusableElementLike | null | undefined;
  },
): "escape" | "tab" | null {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    options.onClose();
    return "escape";
  }

  if (event.key === "Tab" && options.panel) {
    trapFocusInDialog(options.panel, event, options.activeElement);
    return "tab";
  }

  return null;
}

/**
 * Shared accessible modal dialog primitive:
 * - Portals into `document.body` when `document` is available.
 * - Exposes `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, and optional `aria-describedby`.
 * - Moves initial focus inside the dialog on open, traps `Tab`/`Shift+Tab`, handles `Escape`
 *   with propagation stopped, and restores focus to the trigger element on close/unmount.
 */
export function AccessibleDialog({
  open,
  onClose,
  ariaLabelledBy,
  ariaDescribedBy,
  ariaLabel,
  closeOnBackdropClick = true,
  initialFocusRef,
  className,
  panelClassName,
  overlayClassName,
  style,
  panelStyle,
  testId,
  children,
}: AccessibleDialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  const initialFocusTargetRef = useRef(initialFocusRef);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    initialFocusTargetRef.current = initialFocusRef;
  }, [initialFocusRef]);

  useEffect(() => {
    if (!open || typeof document === "undefined") {
      return;
    }

    const dialogId = Symbol("AccessibleDialog");
    openDialogStack.push(dialogId);

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    focusInitialDialogElement(panelRef.current, initialFocusTargetRef.current?.current ?? null);

    const onKeyDown = (event: KeyboardEvent) => {
      if (openDialogStack[openDialogStack.length - 1] !== dialogId) {
        return;
      }
      const activeEl =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      handleDialogKeyDown(event, {
        panel: panelRef.current,
        onClose: () => onCloseRef.current(),
        activeElement: activeEl,
      });
    };

    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const stackIdx = openDialogStack.lastIndexOf(dialogId);
      if (stackIdx >= 0) {
        openDialogStack.splice(stackIdx, 1);
      }
      restoreDialogFocus(previouslyFocused);
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const mergedPanelClassName = [panelClassName, className].filter(Boolean).join(" ") || undefined;
  const resolvedOverlayStyle = style ?? (overlayClassName ? undefined : DEFAULT_OVERLAY_STYLE);

  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (closeOnBackdropClick && event.target === event.currentTarget) {
      onClose();
    }
  };

  const content = (
    <div
      className={overlayClassName}
      style={resolvedOverlayStyle}
      onClick={handleBackdropClick}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        aria-label={ariaLabel}
        tabIndex={-1}
        data-testid={testId}
        className={mergedPanelClassName}
        style={panelStyle}
      >
        {children}
      </div>
    </div>
  );

  if (typeof document !== "undefined") {
    return createPortal(content, document.body);
  }

  return content;
}
