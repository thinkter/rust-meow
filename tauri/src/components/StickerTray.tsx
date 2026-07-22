import { createMemo, createSignal, For, onMount, Show, type JSX } from "solid-js";
import { assetUrl } from "../lib/bridge";
import { Spinner } from "./Primitives";
import type { AppModel, StickerPack } from "../state/app";

/**
 * The placeholder `StickerPack` (see `state/app.ts`) only carries bare
 * `stickerIds: string[]` — there is no per-sticker media path yet, because
 * that lands with the STICKERS agent's real type/RPC. Duck-type a richer
 * shape defensively (same pattern `loadStickers` already uses for the
 * bridge method) so this component starts rendering thumbnails the moment
 * that lands, without needing another edit here.
 */
interface StickerLike {
  id: string;
  localPath?: string;
  path?: string;
}

function stickerLocalPath(pack: StickerPack, stickerId: string): string | undefined {
  const rich = pack as unknown as { stickers?: StickerLike[] };
  const match = rich.stickers?.find((sticker) => sticker.id === stickerId);
  return match?.localPath || match?.path || undefined;
}

export function StickerTray(props: { model: AppModel; chatId: string; onSent?: () => void }): JSX.Element {
  const { state, actions } = props.model;
  const [activeTabId, setActiveTabId] = createSignal("");
  const [sending, setSending] = createSignal("");

  // Lazy: only hits the backend the first time this tray is actually opened,
  // and only if nothing is loaded and nothing already failed (a "Retry"
  // button covers the failure case instead of hammering the RPC).
  onMount(() => {
    if (state.stickers.packs.length === 0 && !state.stickers.loading && !state.stickers.error) {
      void actions.loadStickers();
    }
  });

  const packs = () => state.stickers.packs;

  const activePack = createMemo(() => {
    const packList = packs();
    if (packList.length === 0) return undefined;
    return packList.find((pack) => pack.id === activeTabId()) ?? packList[0];
  });

  async function pick(stickerId: string) {
    if (sending()) return;
    setSending(stickerId);
    try {
      await actions.sendStickerFromPack(stickerId, props.chatId);
      props.onSent?.();
    } finally {
      setSending("");
    }
  }

  return (
    <div class="sticker-tray">
      <Show when={packs().length > 0}>
        <div class="sticker-tab-strip">
          <For each={packs()}>
            {(pack) => (
              <button
                type="button"
                class={`sticker-pack-tab${activePack()?.id === pack.id ? " active" : ""}`}
                aria-label={pack.name}
                title={pack.name}
                onClick={() => setActiveTabId(pack.id)}
              >
                {pack.name.slice(0, 2).toUpperCase()}
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show
        when={!state.stickers.loading}
        fallback={
          <div class="sticker-empty">
            <Spinner label="Loading stickers…" />
          </div>
        }
      >
        <Show
          when={!state.stickers.error}
          fallback={
            <div class="sticker-empty">
              <p>{state.stickers.error}</p>
              <p>
                Stickers you&rsquo;ve sent or received appear here, along with anything you&rsquo;ve favourited.
                WhatsApp doesn&rsquo;t sync your installed sticker packs to linked devices, so the full phone
                library can&rsquo;t show up in this tray.
              </p>
              <button type="button" class="secondary-button" onClick={() => void actions.loadStickers()}>
                Retry
              </button>
            </div>
          }
        >
          <Show
            when={activePack() && activePack()!.stickerIds.length > 0}
            fallback={
              <div class="sticker-empty">
                <p>No stickers yet.</p>
                <p>
                  Stickers you&rsquo;ve sent or received appear here, along with anything you&rsquo;ve favourited.
                  WhatsApp doesn&rsquo;t sync your installed sticker packs to linked devices, so the full phone
                  library can&rsquo;t show up in this tray.
                </p>
              </div>
            }
          >
            <div class="sticker-grid">
              <For each={activePack()!.stickerIds}>
                {(stickerId) => {
                  const path = () => stickerLocalPath(activePack()!, stickerId);
                  const url = () => assetUrl(path());
                  return (
                    <button
                      type="button"
                      class="sticker-cell"
                      aria-label="Send sticker"
                      disabled={sending() === stickerId}
                      onClick={() => void pick(stickerId)}
                    >
                      <Show when={url()} fallback={<div class="media-placeholder" aria-hidden="true" />}>
                        <img src={url()} alt="" loading="lazy" draggable={false} />
                      </Show>
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
