import type { ComputerAccessAnswer, ComputerAccessRequested } from "@t3tools/contracts";
import { appTier, restrictComputerTier, type ComputerPlatform } from "@t3tools/shared/computerApps";
import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";

/** Renderer gestures only open a prompt. Only main's native dialog can widen access. */
export class ComputerConsentAuthority {
  private readonly pending = new Set<string>();
  constructor(
    private readonly options: {
      platform: ComputerPlatform;
      request: (profileId: string, answer: ComputerAccessAnswer) => ComputerAccessRequested;
      answer: (profileId: string, answer: ComputerAccessAnswer) => void;
      show: (profileId: string, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
    },
  ) {}

  async review(profileId: string, offered: ComputerAccessAnswer): Promise<void> {
    const request = this.options.request(profileId, offered);
    const key = `${profileId}\0${offered.backendIncarnation}\0${request.requestId}`;
    if (this.pending.has(key)) throw new Error("This request is already being reviewed.");
    this.pending.add(key);
    try {
      let answer: ComputerAccessAnswer = {
        requestId: request.requestId,
        backendIncarnation: offered.backendIncarnation,
        decisions: [],
      };
      if (request.kind !== "apps") {
        const setup = request.chromeSetup;
        const choice = await this.options.show(profileId, {
          type: "warning",
          title: "F5 computer access",
          message: request.reason,
          detail: setup
            ? `Current browser targets:\n${setup.previousTargets.join("\n")}\nNew target:\n${setup.targetPath}\nThis integration can act on sites you are signed in to.`
            : "Allow this agent session to control apps you separately approve?",
          buttons: ["Deny", "Allow"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (request.kind === "chrome-setup")
          answer = { ...answer, allowChromeSetup: choice.response === 1 };
        else answer = { ...answer, allowSessionActions: choice.response === 1 };
      } else {
        const decisions: ComputerAccessAnswer["decisions"][number][] = [];
        for (const app of request.apps) {
          // Revalidate after each prompt: neither a replaced backend nor an expired
          // request can collect more decisions or receive a late approval.
          this.options.request(profileId, offered);
          const tier = restrictComputerTier(app.tier, appTier(app.appId, this.options.platform));
          if (tier === "blocked") {
            decisions.push({ appId: app.appId, allow: false, allowTyping: false, remember: false });
            continue;
          }
          const choice = await this.options.show(profileId, {
            type: "warning",
            title: "F5 computer access",
            message: `Allow access to ${app.name}?`,
            detail: `${request.reason}\n${tier === "view" ? "Viewing only." : tier === "click" ? "Typing here can run commands. Choose typing separately." : "Control includes typing in this app."}${app.warning === "browser" ? "\nThis app can act on sites you are signed in to." : ""}`,
            buttons:
              tier === "click"
                ? ["Deny", "Allow clicks", "Allow clicks and typing"]
                : ["Deny", tier === "view" ? "Allow viewing" : "Allow control and typing"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
            checkboxLabel: "Always allow in this project",
            checkboxChecked: false,
          });
          decisions.push({
            appId: app.appId,
            allow: choice.response > 0 && choice.response < (tier === "click" ? 3 : 2),
            allowTyping: tier === "click" && choice.response === 2,
            remember: choice.response > 0 && choice.checkboxChecked,
          });
        }
        answer = { ...answer, decisions };
      }
      this.options.request(profileId, offered);
      this.options.answer(profileId, answer);
    } finally {
      this.pending.delete(key);
    }
  }

  async confirmResume(profileId: string, threadTitle: string): Promise<boolean> {
    const choice = await this.options.show(profileId, {
      type: "warning",
      title: "Resume F5 computer control?",
      message: `Resume computer control for ${threadTitle}?`,
      detail:
        "Physical input will pause control again. The agent must take a fresh screenshot before clicking.",
      buttons: ["Cancel", "Resume"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return choice.response === 1;
  }
}
