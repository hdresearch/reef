import { describe, expect, test } from "bun:test";
import { buildGoldenBootstrapScript } from "./golden.js";

describe("golden bootstrap", () => {
  test("builds a child-agent wrapper that sources persisted env", () => {
    const script = buildGoldenBootstrapScript("https://root.example:3000");

    expect(script).toContain("cat > /usr/local/bin/punkin <<'EOF'");
    expect(script).toContain(". /etc/profile.d/reef-agent.sh");
    expect(script).toContain(
      'export PATH="/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"',
    );
    expect(script).toContain("export SERVICES_DIR=/root/reef/services-active");
    expect(script).toContain("export REEF_CHILD_AGENT=true");
    expect(script).toContain('if ! grep -q "reef-agent.sh" "$shell_rc"; then');
    expect(script).toContain("printf '");
    expect(script).toContain('"$PI_PATH" install /root/pi-vers');
    expect(script).toContain('"$PI_PATH" install /root/reef');
  });
});
