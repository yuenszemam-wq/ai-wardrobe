// Phase 3.9B.2：套件格式及安全驗證（純函數）：ZIP 讀寫、CRC、路徑穿越、重複、加密、ZIP 炸彈、大小限制、
// manifest 版本／類型／檔案清單／引用完整性、未登記檔案、私人欄位提示、模型相容性、引用換算。
// 執行：node test/phase39b2.mjs
import { buildModule } from "./doll-build.mjs";
import { checker } from "./p38-setup.mjs";
import { deflateRawSync } from "node:zlib";

const { check, done } = checker();
const Z = await buildModule("shared/zip.ts", "p39b2-zip");
const P = await buildModule("shared/package.ts", "p39b2-pkg");
const enc = new TextEncoder();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const sha = async (b) => Buffer.from(await crypto.subtle.digest("SHA-256", b)).toString("hex");
const manifest = async (extra = {}) => ({ format: "ai-wardrobe-package", format_version: 1, package_type: "garments", created_at: "2026-11-15", title: "測試", garments: [{ key: "g1", name: "紫色 JSK", category: "連身裙", images: [{ path: "files/a.png", type: "processed", primary: true }], templates: [{ avatar_id: "avatar_v2", slot: "dress", fit: { cx: 1 }, data: { pieces: [{ file: "pkg:files/a.png" }] } }, { avatar_id: "dmd_friend", model_name: "朋友的身體", slot: "dress", fit: {}, data: null }], parts: [] }], assets: [], files: { "files/a.png": { sha256: await sha(PNG), size: PNG.length, mime: "image/png" } }, ...extra });
try {
  console.log("ZIP");
  const zip = Z.writeZip([{ path: "manifest.json", data: enc.encode("{}") }, { path: "files/a.png", data: PNG }]);
  const back = await Z.readZip(zip);
  check("寫入及讀回（CRC、大小一致）", back.size === 2 && Buffer.from(back.get("files/a.png")).equals(Buffer.from(PNG)));
  check("CRC32 正確", Z.crc32(enc.encode("123456789")) === 0xcbf43926);
  for (const bad of ["../evil.png", "/abs.png", "a\\b.png", "files/../../x.png", "C:/x.png", "files//x.png", "./x.png"]) check(`拒絕不安全路徑：${bad}`, !Z.safePath(bad));
  // 手動造一個含 ../ 的 ZIP（繞過 writeZip 的檢查）
  const evil = Z.writeZip([{ path: "files/aa.png", data: PNG }]);
  const s = Buffer.from(evil).toString("latin1").replaceAll("files/aa.png", "../../aa.png");
  let err = null; try { await Z.readZip(new Uint8Array(Buffer.from(s, "latin1"))); } catch (e) { err = e.message; }
  check("讀取時拒絕路徑穿越", /不安全/.test(err ?? ""), err);
  const corrupt = zip.slice(); corrupt[43] ^= 0xff; err = null; try { await Z.readZip(corrupt); } catch (e) { err = e.message; }
  check("內容被修改：校驗失敗", !!err, err);
  err = null; try { await Z.readZip(zip, { maxEntries: 1, maxFile: 1e6, maxTotal: 1e6 }); } catch (e) { err = e.message; } check("條目數量上限", /數量/.test(err ?? ""));
  err = null; try { await Z.readZip(zip, { maxEntries: 10, maxFile: 5, maxTotal: 1e6 }); } catch (e) { err = e.message; } check("單檔大小上限", /太大/.test(err ?? ""));
  err = null; try { await Z.readZip(new Uint8Array([1, 2, 3, 4])); } catch (e) { err = e.message; } check("不是 ZIP", /不是有效/.test(err ?? ""));
  // deflate 條目（電腦重新壓縮的套件）
  const big = new Uint8Array(5000).fill(65);
  const comp = deflateRawSync(big);
  const z2 = Buffer.from(Z.writeZip([{ path: "files/b.png", data: big }]));
  // 把儲存條目改為 deflate：重建檔案（本地檔頭 30＋名稱＋資料）
  const name = Buffer.from("files/b.png"); const crc = Z.crc32(big);
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(big.length, 22); lh.writeUInt16LE(name.length, 26);
  const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(big.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(0, 42);
  const body = Buffer.concat([lh, name, comp]); const cd = Buffer.concat([ch, name]);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(body.length, 16);
  const dz = new Uint8Array(Buffer.concat([body, cd, eocd]));
  check("支援 deflate 壓縮的條目", (await Z.readZip(dz)).get("files/b.png").length === 5000);
  // ZIP 炸彈：記錄 10 bytes 但解壓 5000
  const bomb = Buffer.from(dz); bomb.writeUInt32LE(10, 22); bomb.writeUInt32LE(10, body.length + 24);
  err = null; try { await Z.readZip(new Uint8Array(bomb)); } catch (e) { err = e.message; } check("ZIP 炸彈（解壓大小與記錄不符）被拒絕", /不符|校驗/.test(err ?? ""), err);
  void z2;

  console.log("manifest");
  const paths = new Set(["manifest.json", "files/a.png"]);
  let v = P.validateManifest(await manifest(), paths);
  check("有效套件", v.ok && v.manifest.garments[0].name === "紫色 JSK", v.errors);
  v = P.validateManifest(await manifest({ format_version: 9 }), paths);
  check("較新版本：明確提示需要更新 App", !v.ok && /較新版本/.test(v.errors[0]));
  v = P.validateManifest(await manifest({ format: "other" }), paths);
  check("不是 AI Wardrobe 套件", !v.ok);
  v = P.validateManifest(await manifest(), new Set(["manifest.json"]));
  check("缺少檔案", !v.ok && /缺少/.test(v.errors[0]));
  v = P.validateManifest(await manifest(), new Set(["manifest.json", "files/a.png", "files/evil.js"]));
  check("包含未登記的檔案（例如程式碼）被拒絕", !v.ok && /未登記/.test(v.errors[0]));
  const m2 = await manifest(); m2.files["files/a.png"].mime = "image/jpeg";
  check("MIME 與副檔名不符被拒絕", !P.validateManifest(m2, paths).ok);
  const m3 = await manifest(); m3.garments[0].images[0].path = "files/missing.png";
  check("引用不存在的檔案被拒絕", !P.validateManifest(m3, paths).ok);
  const m4 = await manifest(); m4.files["../x.png"] = m4.files["files/a.png"];
  check("檔案清單中的不安全路徑被拒絕", !P.validateManifest(m4, new Set([...paths, "../x.png"])).ok);
  const m5 = await manifest(); m5.garments.push({ ...m5.garments[0] });
  check("重複識別被拒絕", !P.validateManifest(m5, paths).ok);
  const m6 = await manifest(); m6.garments[0].price = 500; m6.garments[0].notes = "備註";
  check("包含私人欄位時提示", P.validateManifest(m6, paths).warnings.some((w) => /價格|備註/.test(w)));
  const m7 = await manifest(); m7.garments[0].name = "x".repeat(500);
  check("過長文字截斷", P.validateManifest(m7, paths).manifest.garments[0].name.length === 120);
  const m8 = await manifest({ package_type: "character", garments: [], assets: [{ key: "a1", kind: "hair", name: "髮", files: ["files/a.png"], config: { parts: [{ file: "pkg:files/other.png" }] } }] });
  check("素材設定引用不屬於它的圖片被拒絕", !P.validateManifest(m8, paths).ok);
  const m9 = await manifest({ package_type: "character", garments: [], assets: [{ key: "a1", kind: "script", name: "x", files: ["files/a.png"] }] });
  check("不支援的素材類型被拒絕", !P.validateManifest(m9, paths).ok);

  console.log("相容性及換算");
  v = P.validateManifest(await manifest(), paths);
  check("Avatar V2 設定：直接套用", P.compatOf(v.manifest.garments[0].templates[0], []).compat === "same");
  check("沒有的身體模型：需要校正", P.compatOf(v.manifest.garments[0].templates[1], [{ id: "dmd_mine", name: "我的" }]).compat === "needs_calibration");
  check("引用換算：pkg: → 新檔案 ID", JSON.stringify(P.remapRefs({ a: ["pkg:files/a.png"] }, new Map([["files/a.png", "file:daf_new"]]))) === '{"a":["file:daf_new"]}');
  let thrown = false; try { P.remapRefs({ a: "pkg:files/x.png" }, new Map()); } catch { thrown = true; }
  check("缺少換算時拋出錯誤（不會寫入失效引用）", thrown);
} catch (e) { console.error(e); check("未預期錯誤", false, String(e)); }
done();
