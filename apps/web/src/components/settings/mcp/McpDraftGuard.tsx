import { useEffect, useRef, useState } from "react";
import { useBlocker, useRouter } from "@tanstack/react-router";
import { Button } from "../../ui/button";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../../ui/alert-dialog";

export function McpConfirmDialog(props: {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <AlertDialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          <AlertDialogDescription>{props.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={props.onCancel}>
            Keep editing
          </Button>
          <Button variant="destructive" onClick={props.onConfirm}>
            {props.confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** Shares one decision between local editor actions and route/project navigation. */
export function useMcpDraftGuard(dirty: boolean, saving: boolean) {
  const pending = useRef<((discard: boolean) => void) | null>(null);
  const [open, setOpen] = useState(false);
  const decide = (discard: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    setOpen(false);
    resolve?.(discard);
  };
  const confirmDiscard = (): Promise<boolean> => {
    if (saving) return Promise.resolve(false);
    if (!dirty) return Promise.resolve(true);
    // A second navigation must never replace the first unresolved decision.
    if (pending.current) return Promise.resolve(false);
    return new Promise((resolve) => {
      pending.current = resolve;
      setOpen(true);
    });
  };
  useEffect(
    () => () => {
      pending.current?.(false);
    },
    [],
  );
  useEffect(() => {
    if (!dirty && !saving) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty, saving]);
  return {
    confirmDiscard,
    requestChange: (action: () => void) => {
      void confirmDiscard().then((discard) => {
        if (discard) action();
      });
    },
    dialog: (
      <McpConfirmDialog
        open={open}
        title="Discard unsaved MCP changes?"
        description="Your server draft has unsaved changes. Discard them to continue."
        confirmLabel="Discard changes"
        onConfirm={() => decide(true)}
        onCancel={() => decide(false)}
      />
    ),
  };
}

function RouterDraftGuard({ confirmDiscard }: { readonly confirmDiscard: () => Promise<boolean> }) {
  useBlocker({ shouldBlockFn: async () => !(await confirmDiscard()), enableBeforeUnload: false });
  return null;
}

export function McpDraftNavigationGuard(props: {
  readonly confirmDiscard: () => Promise<boolean>;
}) {
  const router = useRouter({ warn: false });
  return router ? <RouterDraftGuard {...props} /> : null;
}
