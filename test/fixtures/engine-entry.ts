// Phase 3.8 測試入口：在瀏覽器直接使用正式渲染器（只供測試打包，不會部署）
import { DollRenderer, flatRect } from "../../src/doll/engine";
import { analyze } from "../../src/doll/content";
import { BUILTIN_HEADS, BUILTIN_HAIRS } from "../../shared/avatarV2";
import { defaultFit, defaultOpts } from "../../shared/doll";
import { DEFAULT_BODY_MODEL, buildModel, EMPTY_DEF } from "../../shared/avatarModel";
import { RIG_V2 } from "../../shared/avatarV2";
(window as unknown as { T: unknown }).T = { DollRenderer, flatRect, analyze, BUILTIN_HEADS, BUILTIN_HAIRS, defaultFit, defaultOpts, DEFAULT_BODY_MODEL, buildModel, EMPTY_DEF, RIG_V2 };
