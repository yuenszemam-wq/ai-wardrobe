import { PageTitle, toast } from "../components/ui";
import UploadCenter from "./UploadCenter";

export default function ImportCenter() {
  return (
    <div>
      <PageTitle>上傳衣物</PageTitle>
      <UploadCenter />
    </div>
  );
}

export function CopyBlock({ text, dark = true }: { text: string; dark?: boolean }) {
  return (
    <div className={`mt-3 rounded-2xl p-3 text-[13px] leading-relaxed ${dark ? "bg-velvet text-rose" : "bg-white ring-1 ring-ink/10"}`}>
      <p className="break-all">{text}</p>
      <button
        type="button"
        className={`mt-2 text-[13px] ${dark ? "text-rose underline decoration-amethyst" : "text-amethyst-deep underline"} underline-offset-4`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            toast("已複製");
          } catch {
            toast("未能自動複製，請長按文字複製", "err");
          }
        }}
      >
        複製
      </button>
    </div>
  );
}
