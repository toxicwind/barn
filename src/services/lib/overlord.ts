import { TelegramClient } from "telegram";
import { NewMessage } from "telegram/events/index.js";
import { StoreSession, StringSession } from "telegram/sessions/index.js";
export interface Msg {
  chatId: string;
  chatTitle: string | null;
  sender: string;
  senderId: string | null;
  text: string;
  date: string;
  id: number;
  isChannel: boolean;
  isGroup: boolean;
}
export interface Cfg {
  apiId: number;
  apiHash: string;
  session?: string;
  channels?: string[];
  onNewMessage?: (m: Msg) => void | Promise<void>;
  onLog?: (l: string) => void;
}
export class Overlord {
  private cl: TelegramClient;
  private st = false;
  private cfg: Cfg;
  private rt: any = null;
  private ra = 0;
  private mx = 60000;
  constructor(c: Cfg) {
    this.cfg = c;
    let s: any;
    if (c.session && c.session.length > 10) s = new StringSession(c.session);
    else s = new StoreSession("./sessions/overlord");
    this.cl = new TelegramClient(s, c.apiId, c.apiHash, {
      connectionRetries: 5,
      autoReconnect: true,
    });
  }
  private lg(l: string) {
    (this.cfg.onLog || console.log)(`[overlord] ${l}`);
  }
  static async interactiveLogin(id: number, hash: string) {
    const inp = await import("input");
    const cl = new TelegramClient(new StringSession(""), id, hash, {
      connectionRetries: 5,
    });
    await cl.start({
      phoneNumber: async () => await inp.default.text("Phone:"),
      password: async () => await inp.default.text("2FA:"),
      phoneCode: async () => await inp.default.text("Code:"),
      onError: (e: any) => console.error(e),
    });
    const ss = cl.session.save() as unknown as string;
    await cl.disconnect();
    return ss;
  }
  async start() {
    if (this.st) return;
    if (!this.cl.connected) await this.cl.connect();
    const me: any = await this.cl.getMe();
    this.lg(`connected ${me.username || me.id}`);
    const filt = this.cfg.channels?.length ? this.cfg.channels : undefined;
    this.cl.addEventHandler(
      async (ev: any) => {
        try {
          const m = ev.message;
          const ch = await m.getChat();
          const se = await m.getSender();
          const sn =
            (se as any)?.username ||
            [(se as any)?.firstName, (se as any)?.lastName]
              .filter(Boolean)
              .join(" ") ||
            "unknown";
          const pl: Msg = {
            chatId: String(m.chatId ?? ""),
            chatTitle: (ch as any)?.title ?? null,
            sender: sn,
            senderId: m.senderId ? String(m.senderId) : null,
            text: m.message ?? "",
            date: new Date((m.date ?? 0) * 1000).toISOString(),
            id: m.id,
            isChannel: !!ev.isChannel,
            isGroup: !!ev.isGroup,
          };
          await this.cfg.onNewMessage?.(pl);
        } catch (e: any) {
          this.lg(`ev err ${e.message ?? e}`);
        }
      },
      new NewMessage(filt ? { chats: filt } : {}),
    );
    this.st = true;
    this.ra = 0;
    this.lg("listener active");
  }
  private sched() {
    if (this.rt) return;
    const d = Math.min(1000 * 2 ** this.ra, this.mx);
    this.ra++;
    this.rt = setTimeout(() => {
      this.rt = null;
      this.start().catch(() => this.sched());
    }, d);
  }
  async stop() {
    this.st = false;
    if (this.rt) {
      clearTimeout(this.rt);
      this.rt = null;
    }
    try {
      await this.cl.disconnect();
    } catch {}
    this.lg("stopped");
  }
  get client() {
    return this.cl;
  }
}
