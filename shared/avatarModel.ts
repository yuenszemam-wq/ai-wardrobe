// Phase 3.6A: immutable model descriptor. This is a renderer contract, not a
// persisted user asset or an upload API. V2 remains the sole selectable model.
import type { Rig } from "./avatarRig";
import { AVATAR_V2_ID, AVATAR_V2_BASE, RIG_V2 } from "./avatarV2";

export interface AvatarModel {
  readonly id: string;
  readonly revision: number;
  readonly rig: Rig;
  /** Base URL of cropped body sprites. Trailing slash required. */
  readonly assetBase: string;
}

export const DEFAULT_BODY_MODEL: AvatarModel = {
  id: AVATAR_V2_ID,
  revision: RIG_V2.version,
  rig: RIG_V2,
  assetBase: AVATAR_V2_BASE,
};
