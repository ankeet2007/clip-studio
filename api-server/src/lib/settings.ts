import fs from "fs";
import path from "path";

const SETTINGS_FILE = path.join(process.cwd(), "clips_settings.json");
const DEFAULT_CHANNEL_HANDLE = "@THEY CALL ME A SHOT";

export interface AppSettings {
  channelHandle: string;
}

export function readSettings(): AppSettings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as Partial<AppSettings>;
      return { channelHandle: raw.channelHandle ?? DEFAULT_CHANNEL_HANDLE };
    }
  } catch {}
  return { channelHandle: DEFAULT_CHANNEL_HANDLE };
}

export function writeSettings(data: Partial<AppSettings>): AppSettings {
  const current = readSettings();
  const updated: AppSettings = { ...current, ...data };
  // Write atomically: write to a tmp file first then rename so a mid-write
  // crash can never corrupt the live settings file.
  const tmpFile = SETTINGS_FILE + ".tmp";
  fs.writeFileSync(tmpFile, JSON.stringify(updated, null, 2));
  fs.renameSync(tmpFile, SETTINGS_FILE);
  return updated;
}
