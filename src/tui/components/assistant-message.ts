import { Container, Spacer } from "@mariozechner/pi-tui";
import { markdownTheme, theme } from "../theme/theme.js";
import { HyperlinkMarkdown } from "./hyperlink-markdown.js";

export class AssistantMessageComponent extends Container {
  private body: HyperlinkMarkdown;

  constructor(text: string) {
    super();
    this.body = new HyperlinkMarkdown(text, 1, 0, markdownTheme, {
      // Keep assistant body text in terminal default foreground so contrast
      // follows the user's terminal theme (dark or light).
      color: (line) => theme.assistantText(line),
    });
    this.addChild(new Spacer(1));
    this.addChild(this.body);

    this.setText(text);
  }

  /**
   * Set a colored @Role badge that appears above the message body.
   * Pass null to remove the badge.
   */
  setRoleBadge(role: string | null, color: string | null) {
    if (role) {
      const colorFn = color ? chalk.hex(color) : theme.accent;
      const badgeStr = colorFn(`@${role}`);
      if (!this.roleBadgeText) {
        this.roleBadgeText = new Text(badgeStr, 0, 0);
      } else {
        this.roleBadgeText.setText(badgeStr);
      }
      if (!this.roleBadgeShown) {
        // Insert badge right before the body
        const idx = this.children.indexOf(this.body);
        if (idx >= 0) {
          this.children.splice(idx, 0, this.roleBadgeText);
        }
        this.roleBadgeShown = true;
      }
    } else if (this.roleBadgeShown && this.roleBadgeText) {
      this.removeChild(this.roleBadgeText);
      this.roleBadgeShown = false;
    }
  }

  setText(text: string) {
    const { thinking, content } = splitThinkingFromText(text);

    if (thinking) {
      if (!this.thinkingShown) {
        const idx = this.children.indexOf(this.body);
        if (idx >= 0) {
          this.children.splice(idx, 0, this.thinkingBox, this.thinkingSpacer);
        }
        this.thinkingShown = true;
      }
      this.thinkingBox.setText(thinking);
    } else if (this.thinkingShown) {
      this.removeChild(this.thinkingBox);
      this.removeChild(this.thinkingSpacer);
      this.thinkingShown = false;
    }

    this.body.setText(content);
  }
}
