import { describe, expect, test } from "bun:test";
import remindersExtension from "../extensions/reminders.js";

function createMockPi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function>();
  const userMessages: Array<{ content: string | unknown[]; options?: any }> = [];

  return {
    tools,
    handlers,
    userMessages,
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: Function) {
      handlers.set(event, handler);
    },
    sendUserMessage(content: string | unknown[], options?: any) {
      userMessages.push({ content, options });
    },
  };
}

describe("reminders extension", () => {
  test("clear_reminders cancels pending reminders before they fire", async () => {
    const pi = createMockPi();
    remindersExtension(pi as any);

    const remindMe = pi.tools.get("remind_me");
    const clearReminders = pi.tools.get("clear_reminders");
    const listReminders = pi.tools.get("reminders");

    await remindMe.execute("tool-1", { message: "check sibling status", delay: "1s" });
    const listedBefore = await listReminders.execute("tool-2", {});
    expect(listedBefore.content[0].text).toContain("fires in");

    const cleared = await clearReminders.execute("tool-3", { status: "pending" });
    expect(cleared.content[0].text).toContain("Cleared 1 reminder");

    await Bun.sleep(1100);
    expect(pi.userMessages).toHaveLength(0);

    const listedAfter = await listReminders.execute("tool-4", {});
    expect(listedAfter.content[0].text).toBe("No reminders scheduled.");
  });

  test("clear_reminders can remove fired reminder history after delivery", async () => {
    const pi = createMockPi();
    remindersExtension(pi as any);

    const remindMe = pi.tools.get("remind_me");
    const clearReminders = pi.tools.get("clear_reminders");
    const listReminders = pi.tools.get("reminders");

    await remindMe.execute("tool-1", { message: "barrier check", delay: "1s" });
    await Bun.sleep(1100);

    expect(pi.userMessages).toHaveLength(1);
    expect(String(pi.userMessages[0].content)).toContain("REMINDER");

    const listedFired = await listReminders.execute("tool-2", {});
    expect(listedFired.content[0].text).toContain("fired");

    const cleared = await clearReminders.execute("tool-3", { status: "fired" });
    expect(cleared.content[0].text).toContain("Cleared 1 reminder");

    const listedAfter = await listReminders.execute("tool-4", {});
    expect(listedAfter.content[0].text).toBe("No reminders scheduled.");
  });
});
