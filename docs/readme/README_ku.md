<div align="center" dir="rtl">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · [Ελληνικά](README_el.md) · [മലയാളം](README_ml.md) · **کوردی**

# REA: ئەندازیاریی پێچەوانە بۆ هەر شتێک

### یەک MCP بۆ ئەندازیاریی پێچەوانەی فایلە باینەرییەکان، بەرنامەکان و ڕەفتاری کاتی کارکردن.

**تایبەتمەندییەکت بینی کە بەدڵتە؟ تێبگە چۆن کار دەکات، تا ئاستی باینەری.**

[![npm version](https://img.shields.io/npm/v/rea-agents?style=flat-square&color=cb3837)](https://www.npmjs.com/package/rea-agents)
[![MCP tool catalog](https://img.shields.io/badge/MCP-tool_catalog-5c4ee5?style=flat-square)](../../docs/mcp-contracts.md#generated-catalog)
[![Node.js requirements](https://img.shields.io/badge/Node.js-requirements-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#current-status)
[![skills.sh](https://skills.sh/b/morluto/rea?style=flat-square)](https://skills.sh/morluto/rea/reverse-engineer-anything)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Discord](https://img.shields.io/discord/1556595354999332884?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/GkcryMnJDM)

<a href="https://trendshift.io/repositories/82054?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-82054" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/82054" alt="morluto%2Frea | Trendshift" width="250" height="55" /></a>

**[ماڵپەڕ](https://rea.tools/) · [ڕێبەرەکان](https://rea.tools/guides/) · [نموونە کردارییەکان](https://rea.tools/showcase/)**

[دەستپێکی خێرا](#دەستپێکی-خێرا) · [REA چۆن کار دەکات](#rea-چۆن-کار-دەکات) · [چی دەتوانیت شیکار بکەیت](#چی-دەتوانیت-شیکار-بکەیت) · [نموونە کردارییەکان](#نموونە-کردارییەکان) · [پرسیارە باوەکان](#پرسیارە-باوەکان) · [بەڵگەنامەکان](#بەڵگەنامەکان)

<code>npx rea-agents setup</code>

<br />

<img src="../../docs/assets/rea-hopper-analysis.png" alt="REA پردی شیکارییەکەی لەناو Hopper دەخاتە کار لە کاتی پشکنینی فایلێکی باینەریی ڕەسەندا" width="1200" />

<br /><br />

<table aria-label="کۆمەڵگەی REA">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="../../docs/assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>بەشداری کۆمەڵگەی ئەندازیاریی پێچەوانە بکە</strong>
  </a><br />
  <sub>Discord · پرسیار و وەڵام · نیشاندانی کارەکان</sub>
</td>
</tr>
</table>

<br />

</div>

---

<div dir="rtl">

> [!IMPORTANT]
> REA لە [morluto/rea](https://github.com/morluto/rea)،
> [rea.tools](https://rea.tools/) یان [پاکێجی npm ـی rea-agents](https://www.npmjs.com/package/rea-agents) وەربگرە.
> بەستەرەکانی دامەزراندن و ڕیلیس تەنها لەم سەرچاوە فەرمییانەوە وەربگرە. ناوێکی هاوشێوەی
> ڕیپۆزیتۆری یان README ـێکی کۆپیکراو ئەوە ناسەلمێنێت کە داگرتنێک فەرمییە.

تایبەتمەندییەکت لە ئەپێکدا بینیوە و دەتەوێت لە بەرهەمەکەی خۆتدا هەتبێت؟ داوا لە ئەجێنتەکەت بکە بە REA لێی بکۆڵێتەوە. ئەجێنتەکە دەتوانێت بەبێ کۆدی سەرچاوەی ئەپەکە بیپشکنێت، ڕوونی بکاتەوە تایبەتمەندییەکە چۆن کار دەکات، بەڵگەکان نیشان بدات و وەشانێکی هاوشێوە بۆ پڕۆژەکەت دروست بکات.

REA ئەجێنتەکەت بە ئامرازەکانی پشکنینی باینەرییە ڕەسەنەکان، ئەپەکانی JavaScript و Electron، ئەسێمبلییەکانی .NET و ماڵپەڕەکانەوە دەبەستێتەوە. دەتوانیت هەمان ئامرازەکان لە تێرمیناڵیشەوە بەکاربهێنیت. شیکاری لەسەر کۆمپیوتەرەکەی خۆت ئەنجام دەدرێت و ئەنجامەکان بەڵگە و سنوورەکانی پشت هەر دەرەنجامێک لەخۆ دەگرن.

پرۆسەی ڕێکخستن REA لە ئەجێنتەکەتدا تۆمار دەکات و ڕێنماییە گونجاوەکانی ڕێڕەوی کار دادەمەزرێنێت. شیکاریی ڕەسەن دەتوانێت Hopper، Ghidra یان IDA ـی دامەزراوی سەر کۆمپیوتەرەکەت بەکاربهێنێت؛ ڕێکخستن دەتوانێت بە ئارەزووی خۆت و دوای ڕەزامەندیت Hopper دابمەزرێنێت. شیکاریی ستاتیکیی JavaScript پێویستی بە هیچ بزوێنەرێکی شیکاریی ڕەسەن نییە.

> بۆ ڕێنماییەکانی ڕێکخستن، ڕێبەرە وێنەدارەکان و نموونەی ڕاستەقینە، **[سەردانی ماڵپەڕی REA بکە](https://rea.tools/)**.

## دەستپێکی خێرا

لەسەر Linux، کارپێکردنی Ghidra، JADX و ئامرازەکانی Firmware، هەروەها شیکاریی ستاتیکیی JavaScript/Electron، پێویستیان بە `ps` ـێکی گونجاو لەگەڵ procps هەیە لەسەر `PATH` ـی REA بۆ پشکنینی خاوەندارێتیی پرۆسەکان. هەنگاوەکانی چارەسەرکردن لە `docs/installation.md` لە بەشی "Linux owned-process prerequisite" دان.

### ئەجێنتەکەت ڕێکبخە

دوای دامەزراندنی Node.js و npm، ئەمە جێبەجێ بکە:

```bash
npx rea-agents setup
```

ئەجێنتەکانت هەڵبژێرە، گۆڕانکارییە پێشنیازکراوەکان بپشکنە و پەسەندیان بکە. ڕێکخستن سێرڤەری MCP ـی REA و ڕێنماییە گونجاوەکانی ڕێڕەوی کار زیاد دەکات، و پێشتر یەدەگێک لە شێوەپێدانە هەبووەکانت دەگرێت. دواتر ئەجێنتەکەت دووبارە بکەرەوە.

ڕێکخستن پشتگیریی Claude Code، Codex، Cursor، Gemini CLI، Grok Build و [ئەجێنتەکانی تر](../../docs/installation.md#supported-agents) دەکات. بۆ شێوەپێدانی دابینکەر و تۆمارکردنی دەستیی MCP، سەیری [دامەزراندن و ڕێکخستن](../../docs/installation.md) بکە.

### پرسیار لە ئەجێنتەکەت بکە

```text
لێی بکۆڵەرەوە کە گەڕان لە ئەپی Notes چۆن کار دەکات، بەڵگەکانم نیشان بدە و
تایبەتمەندییەکی هاوشێوە بۆ پڕۆژەکەم دروست بکە.
```

Notes بگۆڕە بە ئەپی ئامانجەکەت و ئەو تایبەتمەندییەی دەتەوێت تێی بگەیت.

### بەکارهێنانی تێرمیناڵ

فۆڵدەرێکی دەرهێنراوی ئەپێکی JavaScript/Electron یان فایلێکی ASAR بپشکنە:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

ئەنجامەکە مۆدیولەکان، ئیمپۆرتەکان، سنوورەکانی Electron و بەڵگەکانیان لەخۆ دەگرێت. ڕێڕەوەکە بە ئامانجەکەی خۆت بگۆڕە، بۆ نموونە لە Windows: `"D:/apps/example"`.

بۆ دامەزراندنی فەرمانی `rea` بۆ بەکارهێنانی بەردەوام:

```bash
npm install --global rea-agents
rea --help
```

بۆ شیکاریی ڕەسەن، سەرەتا دابینکەرێک شێوەپێ بدە. بۆ فەرمانە ڕەسەنەکان، هەڵبژاردنی دابینکەر، snapshot و نووسینی سکریپت، سەیری [ڕێبەری CLI و بەڵگە](../../docs/cli.md) بکە.

### نوێکردنەوەی REA

REA بە خێرایی دەگۆڕێت و وەشانە نوێیەکان زۆرجار چاکسازیی هەڵەکان لەخۆ دەگرن. دامەزراندنەکەت بە نوێیی ڕابگرە.

بۆ CLI ـێک کە بە `npm install --global` یان `bun add --global` دامەزراوە:

```bash
rea update
```

نوێکردنەوەی گشتی بە Bun پێویستی بە Bun 1.2.17 یان نوێتر هەیە. ئەگەر وەشانێکی کۆنتری Bun ـت هەیە، پێش جێبەجێکردنی `rea update` بە دەستی Bun نوێ بکەرەوە.

بۆ نوێکردنەوەی تۆمارکردنی ئەجێنتەکان و skill ـەکەت، ئەو فەرمانی setup ـە جێبەجێ بکە کە نوێکردنەوەکە نیشانی دەدات.

ئەگەر `npx` بەکاردەهێنیت، ڕێکخستنی ئەجێنتەکەت بەمە نوێ بکەرەوە:

```bash
npx rea-agents@latest setup
```

گۆڕانکارییەکانی ڕێکخستن بپشکنە و ئەجێنتەکەت دووبارە بکەرەوە. بۆ فەرمانە یەکجارییەکانی CLI، `npx rea-agents@latest` بەکاربهێنە و فەرمانەکە لە دوایدا بنووسە. لەگەڵ Bun، لە جیاتی `npx rea-agents@latest`، `bunx rea-agents@latest` بەکاربهێنە.

## REA چۆن کار دەکات

ئەجێنتەکەت لە ڕێگەی MCP ـەوە REA بانگ دەکات بۆ پشکنینی ئامانجەکە و شوێنپێهەڵگرتنی کۆدە پەیوەندیدارەکان. REA دۆزینەوەکان لەگەڵ بەڵگەکانیان دەگەڕێنێتەوە. ئەجێنتەکە ئەمانە بەکاردەهێنێت بۆ پرسیاری زیاتر، ڕوونکردنەوەی ڕەفتارەکە، یان نووسین و تاقیکردنەوەی کۆدێکی هاوشێوە. فەرمانەکانی CLI هەمان ڕێڕەوی کار بەکاردەهێنن.

![ڕەوتی لێکۆڵینەوەی REA: ئەجێنتەکەت دەربارەی ئامانجێکی سەر کۆمپیوتەرەکەت دەپرسێت، REA بە ئامرازەکانی شیکاری دەیپشکنێت و شوێنی دەکەوێت، و ئەجێنتەکە کۆد، ئاماژە و نەزانراوە گەڕێنراوەکان بەکاردەهێنێت بۆ ڕوونکردنەوە، دروستکردن و تاقیکردنەوە.](../../website/public/assets/figures/rea-investigation-flow.svg)

[وێنەکە بە قەبارەی تەواو بکەرەوە](../../website/public/assets/figures/rea-investigation-flow.svg).

<a id="current-status"></a>

## چی دەتوانیت شیکار بکەیت

REA پێویستی بە Node.js 22.x (>=22.19)، 24.x (>=24.11) یان 26+ لەگەڵ npm هەیە. ئامرازە زیادەکان و پشتگیریی سیستەمی خانەخوێ بەپێی ئامانجەکە دەگۆڕێن:

| ئامانج                         | ئەوەی REA دەیگەڕێنێتەوە                                                                              | پێداویستی و ڕێبەر                                                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| باینەرییە ڕەسەنەکان            | سوودۆکۆد، ئەسێمبلی، دەقە ناوەکییەکان (strings)، هێماکان، بانگکردنەکان و ئاماژەکان                    | Hopper، Ghidra یان IDA؛ [شیکاریی ڕەسەن](../../docs/native-investigation.md)                                                                    |
| پێکهاتەی ELF بە شێوەی ئۆفلاین   | بەشەکان، سێگمێنتەکان، هێما و relocation ـە ئەسڵییەکان و کاندیدە ستاتیکییەکانی پاراستن                | pwntools کە بەکارهێنەر دابینی دەکات لەسەر Linux x64؛ [دەستنیشانکردنی باینەری](../../docs/binary-diagnostics.md)                                |
| باینەرییەکانی Go               | وەشانی کۆمپایلەری نێوخراو، مۆدیولەکان، جێگرەوەکان و ڕێکخستنەکانی build                               | پشکنینی ستاتیکیی ناوخۆیی بۆ ELF/PE و Mach-O ـی تەنها یەک ئارکیتێکچەر؛ پێویست بە دامەزراندنی Go ناکات                                           |
| باینەرییەکانی Rust             | ناوی crate ـەکان، وەشانەکان، سەرچاوەکان و پەیوەندییەکانی پشتبەستن کە cargo-auditable نێویانی خستووە  | پشکنینی ستاتیکیی ناوخۆیی بۆ ELF/PE و Mach-O ـی تەنها یەک ئارکیتێکچەر؛ [باینەرییەکانی Rust](../../docs/rust-binaries.md)                        |
| بەرهەمی WASM                   | پشتڕاستکردنەوە، بەشەکان، شێوەی وردی WAT بۆ import/export و WAT ـی دیکۆدکراو                          | WABT 1.0.42 کە بەکارهێنەر دابینی دەکات؛ `inspect_wasm_artifact`                                                                                |
| بایتکۆدی EVM                   | هەڵبژێرەرەکانی dispatch، شوێنی بایتەکان، ئارگیومێنتە پێشبینیکراوەکان و توانای گۆڕینی دۆخ             | داتای raw/hex ـی سەر کۆمپیوتەر لەسەر Linux x64؛ [ڕێبەری EVM ـی ئۆفلاین](../../docs/evm-bytecode.md)                                             |
| بنکەدراوەکانی SQLite           | خشتەکان، ستوونەکان، ئیندێکسەکان، view ـەکان، trigger ـەکان و ڕیزە هەڵبژێردراوەکانی خشتە ئاساییەکان   | snapshot ـی بنکەدراو/WAL ـی سەر کۆمپیوتەر؛ Node.js 24.x >=24.15 یان 26+ لەگەڵ سنوورەکانی SQLite ـی ڕەسەن                                       |
| کڕاشە تۆمارکراوەکانی Linux     | تێبینییە خاوەکان، ڕێجستەر و سیگناڵی هەموو thread ـە تۆمارکراوەکان و کاندیدە ئارەزوومەندانەکانی نەخشە | pwntools کە بەکارهێنەر دابینی دەکات لەسەر Linux x64؛ GDB/pwndbg ـی ئارەزوومەندانە؛ [کڕاشە تۆمارکراوەکان](../../docs/recorded-crashes.md)       |
| JavaScript / Electron          | مۆدیولەکان، ئیمپۆرتەکان، source map، ڕێڕەوەکان، IPC و پەیوەندیی پێوەکراوە ڕەسەنەکان                  | Node.js و npm؛ Linux: `ps` ـی گونجاو لەگەڵ procps؛ [شیکاریی بەرنامە](../../docs/javascript-application-workflows.md)                           |
| ماڵپەڕەکان                     | پێکهاتەی پەڕە، سکریپتەکان، چاودێرییەکانی تۆڕ و وێنەی شاشەی داواکراو                                  | وێبگەڕێکی خێزانی Chrome؛ [شیکاریی وێبگەڕ](../../docs/browser-observation.md)                                                                   |
| تۆمارە پاشەکەوتکراوەکانی تۆڕ   | داواکارییەکان، وەڵامەکان، payload ـە ئاشکراکان و شوێنەکانیان لە سەرچاوەدا                             | HAR یان SAZ ـی Fiddler Everywhere؛ mitmdump لەسەر Linux بۆ تۆمارە ڕەسەنەکانی mitmproxy؛ [ڕێبەری تۆمارکردن](../../docs/web-network-captures.md) |
| ئەسێمبلییەکانی .NET            | میتاداتا، ڕێنماییەکانی CIL، پشتبەستنە ڕەسەنە ڕاگەیەنراوەکان و بەراوردی build ـەکان                   | هیچ (تەنها ستاتیکی)؛ [ڕێبەری کۆدی بەڕێوەبراو](../../docs/managed-code-analysis.md)                                                             |
| APK ـەکانی Android             | ڕاگەیاندنەکانی Manifest، کڵاسەکان، میتۆدە دیکۆمپایلکراوەکان و ئاماژەکان                               | JADX بەبێ ڕووکاری گرافیکی و JDK ـی تەواو لەسەر Linux/macOS/Windows x64؛ [ڕێبەری Android](../../docs/android-analysis.md)                       |
| ئامێرەکانی Android             | ئامێرەکان، پاکێجەکان، پرۆسەکان، لۆگەکان، dump ـەکان، وێنەی شاشە و گواستنەوەی APK/فایل                | adb کە بەکارهێنەر دابینی دەکات (ئیمیولەیتەر یان ئامێری ڕاستەقینە)؛ [ڕێبەری ADB](../../docs/adb-device-analysis.md)                             |
| پڕۆژەکانی JEB                  | یەکەکانی پڕۆژە لە بزوێنەرەکەوە، digest ـی بەرهەمەکان و سوودۆکۆدی جۆر/میتۆد                           | کلاینتێکی JEB کە بەکارهێنەر دەیخاتە کار و MCP پێشکەش دەکات، بە REA_JEB_MCP_URL هەڵدەبژێردرێت؛ [ڕێبەری JEB](../../docs/jeb-analysis.md)          |
| سەرچاوەکانی Android            | Manifest ـی دیکۆدکراو، خشتەی دەقەکان، زمانەکان و زانیاریی وەشان                                      | لانچەری Apktool کە بەکارهێنەر دابینی دەکات؛ [ڕێبەری سەرچاوەکان](../../docs/apktool-resource-analysis.md)                                        |
| ئەپەکانی Flutter               | hash ـی snapshot ـی Dart، digest ـی کتێبخانەکان بەپێی هەر ABI و سەرچاوەی build ـی بزوێنەر            | هیچ (شیکردنەوەی ستاتیکیی APK)؛ [ڕێبەری Flutter](../../docs/flutter-analysis.md)                                                                |
| Firmware                       | ناوچەکان، ئەنجامەکانی دەرهێنان و ڕادەستکردن بە شیکاریی ڕەسەن                                         | Binwalk / Unblob لەسەر Linux؛ [ڕێبەری Firmware](../../docs/firmware-analysis.md)                                                               |
| پاکێتە تۆمارکراوەکان           | فیلدە هەڵبژێردراوەکان، بەها دووبارەبووەکان، فلتەرەکان و یاساکانی decode-as                           | Linux: TShark 4.x + prlimit؛ [ڕێبەری تۆمارکردنی پاکێت](../../docs/packet-captures.md)                                                          |
| پوختەی پاکێتەکان               | خاڵە کۆتاییەکان (endpoints)، DNS، TLS SNI، دابەشبوونی پرۆتۆکۆلەکان و داواکارییەکانی HTTP             | tshark و capinfos کە بەکارهێنەر دابینیان دەکات (لەسەر Linux پشتڕاستکراوەتەوە)؛ [ڕێبەری pcap](../../docs/pcap-analysis.md)                      |
| سیگناڵە لۆجیکییە تۆمارکراوەکان | تێبینییەکانی دیکۆدەر، مەودای نموونەکان و زانیاریی دەستنیشانکردن                                      | Linux: sigrok-cli 0.7.2 + prlimit؛ [تۆمارەکانی سیگناڵ](../../docs/signal-recordings.md)                                                        |
| پاکێج و سەرچاوەکان             | لیستی فایلەکان، digest ـەکان، plist ـەکان، پێکهاتەی bundle ـی Apple و سەرچاوە دەرهێنراوەکان          | [ڕێبەری بەرهەم و JavaScript](../../docs/javascript-artifact-reconstruction.md)، [بەرنامەکانی Apple](../../docs/apple-application-analysis.md)  |
| ڕەفتاری پرۆسە                  | دەرچەی تێرمیناڵ، کارلێکەکان، چاودێرییەکانی دەرچوون و سیستەمی فایل، و بەراوردی کارپێکردنەکان          | Linux/macOS لەگەڵ PTY ـی ڕەسەن؛ [تۆمارکردنی پرۆسە](../../docs/process-capture.md)                                                              |

پشکنینی ستاتیکیی JavaScript و .NET فایلە دابینکراوەکان دەخوێنێتەوە بەبێ ئەوەی بەرنامەکە کار پێ بکات. تۆمارکردنی کاتی کارکردن ئامانجە هەڵبژێردراوەکە بە مۆڵەتەکانی بەکارهێنەرەکەت کار پێدەکات یان کارلێکی لەگەڵ دەکات؛ ڕێبەری هەر جۆرێکی تۆمارکردن کاریگەرییەکانی ڕوون دەکاتەوە.

بۆ پشکنینی ئۆفلاینی باینەریی ڕەسەن، REA پشتگیریی GNU objdump و Rizin ـیش دەکات کە بەکارهێنەر دابینیان دەکات.
بۆ ڕێکخستنی دابینکەر، فەرمانەکانی CLI و سنوورەکانی Evidence سەیری [ڕێبەری ئامرازەکانی ئەندازیاریی پێچەوانە](../../docs/reverse-engineering-tools.md)
بکە. REA هیچ کامیان دانامەزرێنێت و نوێیان ناکاتەوە.

<a id="choosing-a-deep-analysis-provider"></a>

فۆرماتە ڕەسەنەکان و پشتگیریی سیستەمی خانەخوێ بەپێی دابینکەر جیاوازن. سەیری [ڕێکخستنی Hopper و Ghidra](../../docs/installation.md#hopper)، [ڕێبەری IDA](../../docs/ida-provider.md) (لەگەڵ پردێکی MCP ـی ڕەسەنی ئارەزوومەندانە)، [ڕێبەری دیکۆمپایلەری Kuna](../../docs/kuna-provider.md) و [پشتگیریی تاقیکاریی Ghidra لە Windows](../../docs/windows-ghidra-p0.md) بکە. Ghidra هەروەها پشتگیریی [شیکاریی DOS ـی ١٦ بیتی](../../docs/ghidra-dos.md) دەکات. بۆ باینەرییە گەورەکان، ماوەی دەستپێکردنی دابینکەر بە `REA_GHIDRA_STARTUP_TIMEOUT_MS` یان `REA_HOPPER_STARTUP_TIMEOUT_MS` زیاد بکە. بۆ هەڵبژاردنی دابینکەر، سەیری [ڕێبەری CLI](../../docs/cli.md#choose-a-provider) بکە. بۆ ئەو تایبەتمەندییانەی دوای دوایین وەشانی npm زیاد کراون، [بەردەستبوونی وەشانەکان](../../docs/installation.md#released-package-and-main) بپشکنە.

## نموونە کردارییەکان

[![وێنەی نموونەکانی pan ـی دەنگی DX-Ball، پردی کلیپبۆردی Notion و ئەڵقەی فیشەکی TH04](../../docs/assets/rea-showcases.png)](https://rea.tools/showcase/)

### DX-Ball: دووبارە دروستکردنەوەی ژمێرکاریی pan ـی دەنگ

بانگکردنێکی دەنگ تا فەنکشنی یاریدەدەری گۆڕینی شوێن بۆ pan شوێن بکەوە، ڕێنماییەکان بپشکنە و سوودۆکۆدی ناتەواو بکە بە C. وەشانە دووبارە دروستکراوەکە لە هەموو ٣٬٢٠٥ تاقیکردنەوەی x86 ـی ئەسڵی سەردەکەوێت و هەموو ٦٣ بایتی فەنکشنە کۆمپایلکراوەکە وەک خۆی بەرهەم دەهێنێتەوە.

[خوێندنەوەی نموونەکە](https://rea.tools/showcase/dx-ball/) ·
[کۆگای دووبارە دروستکردنەوە](https://github.com/N0zoM1z0/dx-ball)

### Notion: شوێنپێهەڵگرتنی پردی کلیپبۆردی Electron

API ـی کلیپبۆردی renderer بدۆزەرەوە، لە ڕێگەی preload و IPC ـەوە تا پرۆسەی سەرەکی شوێنی بکەوە و فۆرماتی دەوڵەمەندی کلیپبۆرد بپشکنە.

[خوێندنەوەی نموونەکە](https://rea.tools/showcase/notion/)

### TH04: گەڕاندنەوەی ژمێرکاریی ئەڵقەی فیشەک لە DOS

ڕێنماییە ١٦ بیتییەکانی یارییە ئەسڵییەکەی PC-98 بپشکنە، ژمێرکارییەکانی گۆشەی جێگیر و ئاراستەکراو بگەڕێنەرەوە و کۆدی C++ ـی دووبارە دروستکراو لەگەڵ دەرچەی کۆمپایلەرە مێژووییەکە بەراورد بکە.

[خوێندنەوەی نموونەکە](https://rea.tools/showcase/th04/) ·
[کۆگای دووبارە دروستکردنەوە](https://github.com/N0zoM1z0/th04)

ئەگەر REA ـت بۆ شتێکی سەرنجڕاکێش بەکارهێناوە، پێمان خۆشە بیبینین. نموونەکەت لە [issue](https://github.com/morluto/rea/issues) یان [pull request](https://github.com/morluto/rea/pulls) ـێکدا بڵاو بکەرەوە، لەگەڵ ئامانجەکە، پرسیارەکەت، چۆن REA یارمەتی دایت و چیت دۆزییەوە.

## پرسیارە باوەکان

<details>
<summary><strong>کام ئەجێنتانە دەتوانن REA بەکاربهێنن؟</strong></summary>

هەر ئەجێنتێک کە پشتگیریی سێرڤەری MCP ـی سەر کۆمپیوتەر بکات. ڕێکخستن [ئەجێنتە پشتگیریکراوەکان](../../docs/installation.md#supported-agents) شێوەپێدەدات؛ کلاینتەکانی تر دەتوانن [تۆمارکردنی دەستیی MCP](../../docs/installation.md#mcp-registry) بەکاربهێنن.

</details>

<details>
<summary><strong>پێویستم بە Hopper، Ghidra یان IDA هەیە؟</strong></summary>

شیکاریی قووڵی ڕەسەن یەکێکیان بەکاردەهێنێت. پشکنینی ستاتیکیی JavaScript و .NET بەبێ بزوێنەری شیکاریی ڕەسەن کار دەکات. ڕێکخستن دەتوانێت دوای ڕەزامەندیت Hopper دابمەزرێنێت؛ بۆ Ghidra و IDA ئەو وەشانانە بەکاردێن کە پێشتر دامەزراندووتن. سەیری [ڕێکخستنی دابینکەر](../../docs/installation.md#hopper) بکە.

</details>

<details>
<summary><strong>پێویستە سەرەتا Hopper بکەمەوە؟</strong></summary>

REA کاتێک کارێک پێویستی پێی بێت Hopper دەکاتەوە. لە macOS، لە یەکەم کارپێکردندا لەوانەیە پەنجەرەیەک داوات لێبکات دۆخی demo هەڵبژێریت یان مۆڵەتەکەت چالاک بکەیت. پێش یەکەم کرداری CLI/MCP یان کارێکی بێ چاودێری، ئەو پەنجەرەیە لە هەمان دانیشتنی بەکارهێنەردا تەواو بکە. ئەگەر پێویست بوو، Hopper بە دەستی بکەرەوە. سەیری [دەستپێکردن و چارەسەرکردنی کێشەکانی Hopper](../../docs/installation.md#launcher-paths-and-troubleshooting) بکە.

</details>

<details>
<summary><strong>دامەزراندنی skill لە skills.sh چی دەکات؟</strong></summary>

skill ـەکە ڕێنماییەکانی لێکۆڵینەوە بۆ ئەجێنتەکەت دابین دەکات. `npx rea-agents setup` بەکاربهێنە
بۆ تۆمارکردنی سێرڤەری MCP ـی REA و دامەزراندنی ڕێنماییە گونجاوەکان، پاشان ئەجێنتەکەت دووبارە بکەرەوە. سەیری [دامەزراندنی تەنها skill](../../docs/installation.md#skill-only-installation) بکە.

</details>

<details>
<summary><strong>REA چ کۆدێک دەگەڕێنێتەوە؟</strong></summary>

شیکاریی ڕەسەن سوودۆکۆد و ئەسێمبلی دەگەڕێنێتەوە. شیکاریی JavaScript/Electron مۆدیولەکان و پەیوەندییەکانیان دەدۆزێتەوە. ئەجێنتەکەت ئەم دۆزینەوانە بەکاردەهێنێت بۆ نووسین و تاقیکردنەوەی کۆدێکی هاوشێوە؛ [نموونە کردارییەکان](#نموونە-کردارییەکان) نموونەی تەواوکراو پیشان دەدەن.

</details>

<details>
<summary><strong>ئایا REA ئەپەکەم بار دەکاتە سەر ئینتەرنێت؟</strong></summary>

REA ئامانجەکان لەسەر کۆمپیوتەرەکەی خۆت شیکار دەکات. ئەجێنتەکەت ئەنجامی ئامرازەکان وەردەگرێت، و دابینکەری مۆدێلەکەی سیاسەتی داتای تایبەت بە خۆی هەیە.

</details>

<details>
<summary><strong>ئەگەر تووشی هەڵەیەک بووم چی بکەم؟</strong></summary>

سەرەتا نوێی بکەرەوە؛ لەوانەیە وەشانێکی نوێ پێشتر چاکی کردبێت.

بۆ CLI ـێک کە بە `npm install --global` یان `bun add --global` دامەزراوە:

```bash
rea update
```

بۆ ڕێکخستنی ئەجێنت لە ڕێگەی `npx` ـەوە:

```bash
npx rea-agents@latest setup
```

ئەگەر ئەجێنت بەکاردەهێنیت، [نوێکردنەوەی ڕێکخستن](#نوێکردنەوەی-rea) تەواو بکە و ئەجێنتەکە دووبارە بکەرەوە. هەمان کار دووبارە تاقی بکەرەوە. ئەگەر کێشەکە بەردەوام بوو، [issue ـێک بکەرەوە](https://github.com/morluto/rea/issues)
و وەشانی REA، جۆری ئامانج، هەنگاوەکانی دووبارەکردنەوەی کێشەکە و دەرچەی هەڵەکە بنووسە.

</details>

## بەڵگەنامەکان

لە [ڕێبەرە کردارییەکانی ماڵپەڕ](https://rea.tools/guides/) دەست پێبکە.
بۆ هەڵبژاردە وردەکان، پێشمەرجەکان و گرێبەستەکانی ئەنجام:

- [دامەزراندن و ڕێکخستن](../../docs/installation.md): تۆمارکردنی ئەجێنت، شێوەپێدانی دابینکەر، نوێکردنەوە و لابردن.
- [ئامادەیی و چارەسەرکردنی کێشە](../../docs/installation.md#check-readiness-for-your-task): دۆزینەوەی کێشەی ئەجێنتێک یان بزوێنەرێکی شیکاری.
- [CLI و بەڵگە](../../docs/cli.md): فەرمانەکان، هەڵبژاردنی دابینکەر، snapshot، import/export و کۆدەکانی دەرچوون.
- [گرێبەستەکانی MCP](../../docs/mcp-contracts.md) و [پرۆمپتەکانی ئەجێنت](../../docs/mcp-prompts.md): ئەنجامی ئامرازەکان، دانیشتنەکان و لێکۆڵینەوە ڕێنماییکراوەکان.
- [کەتەلۆگی ئامرازەکان](../../docs/mcp-contracts.md#generated-catalog): لیستێکی خۆکار دروستکراوی ئامراز، دابینکەر و فەرمانەکانی CLI.
- [نەخشەڕێگا](../../docs/roadmap.md): کارە پلانبۆدانراوەکان و شوێنکەوتنی تواناکان.

خاڵە لاوازە ئەمنییەکان لە ڕێگەی [SECURITY.md](../../SECURITY.md) ـەوە ڕاپۆرت بکە.

## مێژووی ئەستێرەکان

🎉 **٣٠٠٬٠٠٠ ئەستێرەی GitHub — سوپاس!**

سوپاس بۆ هەموو ئەوانەی REA بەکاردەهێنن، هەڵە ڕاپۆرت دەکەن، داوای تایبەتمەندی دەکەن، build ـەکان تاقی دەکەنەوە و بە چاکسازی بەشداری دەکەن.

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="مێژووی ئەستێرەکانی GitHub ـی REA" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## ئاگادارکردنەوە

بۆ ڕێنمایی دەربارەی بەکارهێنانی بەرپرسیارانە، سەیری [DISCLAIMER.md](../../DISCLAIMER.md) بکە.

The project's position on illegal or unauthorized use covers all REA versions,
distribution channels, and platforms; each copy retains its applicable licenses.

REA بۆ توێژینەوەی یاسایی، فێرکردن، گونجاندن لەگەڵ سیستەمەکانی تر، پاراستنی نەرمەکاڵا، و شیکاریی ئەو نەرمەکاڵایانەیە کە خاوەنیانیت یان مۆڵەتی پشکنینیانت هەیە.

## بەشداریکردن

زۆر خۆشحاڵ دەبین یارمەتیی REA بدەیت! بۆ ڕاپۆرتکردنی هەڵە یان پێشنیازکردنی تایبەتمەندی [issue ـێک بکەرەوە](https://github.com/morluto/rea/issues)، یان بۆ باشترکردنی کۆد یان بەڵگەنامەکان [pull request بنێرە](https://github.com/morluto/rea/pulls).

بۆ ئامادەکردنی ژینگەی گەشەپێدان و پشکنینەکان سەیری [CONTRIBUTING.md](../../CONTRIBUTING.md) بکە، بۆ قۆناغەکانی پشتڕاستکردنەوە [تاقیکردنەوە](../../docs/testing.md)، و بۆ پێکهاتەی پڕۆژەکە [نەخشەی تەلارسازی](../../docs/architecture.mermaid).

## مۆڵەت

[MIT](../../LICENSE)

REA-authored code is licensed under MIT. Third-party material retains its own
licenses and copyright notices; see
[Third-party notices](../../THIRD_PARTY_NOTICES.md) for the dependency inventory,
preserved license texts, and external-tool terms.

**You must legally obtain and be authorized to use commercial tools**, including
IDA Pro / Hex-Rays decompilers, Hopper, and JEB, under their applicable
licenses. REA grants no tool license, key, or activation entitlement. Trials and
demos remain subject to vendor terms, including user, feature, automation, and
output sharing restrictions. Cracked copies, stolen keys, unauthorized key
sharing, and bypassing license restrictions are not authorized. This guidance
does not amend MIT or third-party licenses.

</div>
