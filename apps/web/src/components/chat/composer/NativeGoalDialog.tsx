import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";

const DEFAULT_TOKEN_BUDGET = 10000;
// Mirrors the `goalSet` command limits in contracts.
const MAX_OBJECTIVE_LENGTH = 16000;
const MAX_TOKEN_BUDGET = 10_000_000;

/** Starts a provider-native goal: an objective the agent pursues until done or out of budget. */
export function NativeGoalDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (objective: string, tokenBudget: number) => Promise<boolean>;
}) {
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState(String(DEFAULT_TOKEN_BUDGET));
  const [submitting, setSubmitting] = useState(false);
  const tokenBudget = Number(budget);
  const valid =
    objective.trim().length > 0 &&
    Number.isSafeInteger(tokenBudget) &&
    tokenBudget >= 1 &&
    tokenBudget <= MAX_TOKEN_BUDGET;

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      if (await props.onSubmit(objective.trim(), tokenBudget)) {
        setObjective("");
        setBudget(String(DEFAULT_TOKEN_BUDGET));
        props.onOpenChange(false);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-base">Set goal</DialogTitle>
            <DialogDescription>
              The agent keeps working toward this objective until it is met or the token budget runs
              out.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="grid gap-1.5">
              <Label htmlFor="native-goal-objective">Objective</Label>
              <Textarea
                id="native-goal-objective"
                value={objective}
                maxLength={MAX_OBJECTIVE_LENGTH}
                onChange={(event) => setObjective(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void submit();
                  }
                }}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="native-goal-budget">Token budget</Label>
              <Input
                id="native-goal-budget"
                type="number"
                min={1}
                max={MAX_TOKEN_BUDGET}
                step={1}
                value={budget}
                onChange={(event) => setBudget(event.currentTarget.value)}
              />
            </div>
          </DialogPanel>
          <DialogFooter variant="bare">
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit" disabled={!valid || submitting}>
              Start goal
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
