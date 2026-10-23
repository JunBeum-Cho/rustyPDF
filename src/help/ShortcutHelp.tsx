import { For, createEffect, createSignal } from "solid-js";
import { shortcutLabel } from "../platform/shortcuts";
import "./help.css";

const [open, setOpen] = createSignal(false);

export const toggleShortcutHelp = () => setOpen((v) => !v);

const GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: "파일",
    items: [
      ["PDF 열기", shortcutLabel("O")],
      ["저장", shortcutLabel("S")],
      ["다른 이름으로 저장", shortcutLabel("S", true)],
      ["인쇄", shortcutLabel("P")],
      ["탭 닫기", shortcutLabel("W")],
      ["다음 / 이전 탭", `${shortcutLabel("Tab")} / ${shortcutLabel("Tab", true)}`],
    ],
  },
  {
    title: "편집",
    items: [
      ["실행 취소", shortcutLabel("Z")],
      ["다시 실행", `${shortcutLabel("Z", true)} / ${shortcutLabel("Y")}`],
      ["선택한 주석 삭제", "Delete"],
      ["선택 페이지 회전 (시계 / 반시계)", "R / Shift+R"],
    ],
  },
  {
    title: "도구",
    items: [
      ["선택", "V"],
      ["텍스트", "T"],
      ["형광펜", "H"],
      ["펜", "P"],
    ],
  },
  {
    title: "보기",
    items: [
      ["확대", shortcutLabel("+")],
      ["축소", shortcutLabel("-")],
      ["100%", shortcutLabel("0")],
      ["검색", shortcutLabel("F")],
      ["사이드바", shortcutLabel("\\")],
      ["이전 / 다음 페이지", "← / →"],
      ["처음 / 마지막 페이지", "Home / End"],
      ["단축키 도움말", `? / ${shortcutLabel("/")}`],
    ],
  },
];

export function ShortcutHelp() {
  let dialog: HTMLDialogElement | undefined;
  createEffect(() => {
    if (!dialog) return;
    if (open() && !dialog.open) dialog.showModal?.();
    else if (!open() && dialog.open) dialog.close();
  });
  return (
    <dialog
      class="help-dialog"
      ref={dialog}
      aria-label="단축키 도움말"
      onClose={() => setOpen(false)}
      onClick={(e) => { if (e.target === dialog) setOpen(false); }}
    >
      <h2>단축키</h2>
      <div class="help-groups">
        <For each={GROUPS}>
          {(group) => (
            <section>
              <h3>{group.title}</h3>
              <dl>
                <For each={group.items}>
                  {([label, keys]) => (
                    <>
                      <dt>{label}</dt>
                      <dd><kbd>{keys}</kbd></dd>
                    </>
                  )}
                </For>
              </dl>
            </section>
          )}
        </For>
      </div>
      <form method="dialog"><button class="toolbar-btn">닫기</button></form>
    </dialog>
  );
}
