# PLAN: interactive-subagents Modüler Yeniden Yapılandırma

Bu plan, `interactive-subagents` (`~/.pi/agent/extensions/interactive-subagents`) eklentisinin monolitik `index.ts` dosyasını alt modüllere bölmek, ölü kodları temizlemek ve yol çözümlemesini sertleştirmek için hazırlanmıştır.

> **Uygulayıcı Ajan İçin Temel Kural:**
> Herhangi bir dosyada değişiklik yapmadan önce o dosyayı ve ilgili import/export hedeflerini `read` aracıyla **baştan sona oku**. Asla dosya içeriğini görmeden veya varsayımlara dayanarak kod değiştirme.

---

## 1. Mimari Kısıtlar ve Depo Standartları (`AGENTS.md`)
1. **İçe Aktarımlar:** Göreceli import'lar kesinlikle açık `.ts` uzantısı taşımalıdır (`import { foo } from "./bar.ts";`).
2. **Sözleşme Bütünlüğü (Pure-Move Refactor):** `index.ts` dosyasından dışa aktarılan 43 sembolün tamamı korunmalıdır. Dışa aktarılan semboller yeni modüllerden `index.ts` içine import edilip re-export edilmelidir.
3. **Durum Sahipliği (State Ownership):** `runningSubagents` (`Map<string, RunningSubagent>`) ve `latestPi` (`ExtensionAPI | null`) referansları `index.ts` üzerinde yaşar; alt modüllere dependency injection / parametre (`deps`) olarak aktarılır.
4. **Çekirdek İzolasyonu:** `node:*` harici bağımlılık eklenemez. Sadece mevcut paketler (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@sinclair/typebox`) kullanılabilir.
5. **Doğrulama Kapısı:** Her adım sonrası `npx tsc -p tsconfig.json --noEmit` (exit 0) ve `npm test` (83/83 birim testi yeşil) çalıştırılmalıdır.

---

## 2. Aşama 1: Temizlik ve Yol Sertleştirmesi

### 1.1 `subagent-done.ts` - `agentStarted` Ölü Bayrağını Kaldırma
- **Okunacak dosya:** `pi-extension/subagents/subagent-done.ts` (satır 120-225 arası)
- **Yapılacak işlem:**
  - Satır 127 civarındaki `let agentStarted = false;` deklarasyonunu sil.
  - Satır 215 civarındaki `pi.on("agent_start", () => { agentStarted = true; ... })` içindeki `agentStarted = true;` atamasını sil.
  - Değişkenin başka yerde kullanılmadığını teyit et.

### 1.2 `agents/discovery.ts` - `getBundledAgentsDir` ve Arama Yolları
- **Okunacak dosya:** `pi-extension/subagents/agents/discovery.ts` (tamamı)
- **Yapılacak işlem:**
  - `getBundledAgentsDir()` fonksiyonunu incele:
    ```ts
    export function getBundledAgentsDir(): string {
      return join(DISCOVERY_DIR, "../../../agents");
    }
    ```
  - Bu fonksiyonun hedeflediği dizinin (`.../interactive-subagents/agents`) varlığını `existsSync` ile kontrol etmesini sağla; dizin bulunamazsa boş veya güvenli fallback sağlamasını sağla.
  - Ajan arama hiyerarşisinin (`loadAgentDefaults` ve `discoverAgentDefinitions`) şu sırayı koruduğunu doğrula:
    1. Proje: `join(process.cwd(), ".pi", "agents", ...)`
    2. Global: `join(getAgentConfigDir(), "agents", ...)`
    3. Paket: `join(getBundledAgentsDir(), ...)`

### 1.3 Aşama 1 Doğrulaması
- `npx tsc -p tsconfig.json --noEmit` -> exit 0
- `npm test` -> 83/83 test pass

---

## 3. Aşama 2: `index.ts` Modüler Bölümleme

Mevcut `index.ts` dosyası 1197 satırdır. Aşağıdaki 6 modül oluşturularak sorumluluklar ayrıştırılacaktır.

### 2.1 `lifecycle/steer.ts`
- **İçerik:** `steerSubagent`, `handleSubagentSteer`.
- **Bağımlılıklar:** `sendCommand` (`../tmux.ts`), `RunningSubagent` tipi, `runningSubagents` haritası (parametre olarak alınır), `updateWidget` geri çağrısı.
- **Dışa aktarım:** `steerSubagent`, `handleSubagentSteer`.

### 2.2 `lifecycle/dispatcher.ts`
- **İçerik:**
  - `checkAskSidecar(sessionFile: string, subagentName: string, pi: ExtensionAPI | null): void`
  - `attachSubagentWatcher(running: RunningSubagent, pi: ExtensionAPI, options?: ...): void`
  - Gözetim ve sayaç fonksiyonları: `statusTimer`, `startStatusSupervision(...)`, `startWidgetRefreshLater(...)`.
- **Bağımlılıklar:** `watchSubagent` (`./watch.ts`), `resolveResultPresentation` (`./watch.ts` / `../tui/widgets.ts`), `updateWidget` fonksiyonu.

### 2.3 `lifecycle/launch.ts`
- **İçerik:**
  - `LaunchContext` arayüzü
  - `launchSubagent(params: Static<typeof SubagentParams>, ctx: LaunchContext, runningSubagents: Map<string, RunningSubagent>): Promise<RunningSubagent>`
- **Bağımlılıklar:** `agents/discovery.ts`, `lifecycle/seed.ts`, `cli/args.ts`, `sandbox.ts`, `tmux.ts`.

### 2.4 `lifecycle/resume.ts`
- **İçerik:**
  - `resumeSubagent(name: string, message: string | undefined, entry: NameRegistryEntry, parentArtifactDir: string, ctx: LaunchContext, pi: ExtensionAPI, runningSubagents: Map<string, RunningSubagent>): ...`
- **Bağımlılıklar:** `session.ts`, `sandbox.ts`, `cli/args.ts`, `tmux.ts`, `lifecycle/dispatcher.ts`.

### 2.5 `tui/message-renderers.ts`
- **İçerik:**
  - `subagent_question` render fonksiyonu (`pi.registerMessageRenderer`)
  - `subagent_result` render fonksiyonu (`pi.registerMessageRenderer`)
- **Bağımlılıklar:** `@earendil-works/pi-tui` (`Box`, `Text`), `@earendil-works/pi-coding-agent` (`keyHint`), `formatElapsed` (`./widgets.ts`).

### 2.6 `tools/subagent-tools.ts`
- **İçerik:**
  - `SubagentParams` TypeBox şeması
  - `registerSubagentTool(pi: ExtensionAPI, deps: ...): void`
  - `registerSubagentsListTool(pi: ExtensionAPI): void`
  - `registerSubagentMessageTool(pi: ExtensionAPI, deps: ...): void`
  - `registerSubagentCommand(pi: ExtensionAPI): void`
- **Bağımlılıklar:** `launchSubagent`, `resumeSubagent`, `handleSubagentSteer`, `isMuxAvailable`, `muxSetupHint`, `registry.ts`.

### 2.7 `index.ts` Giriş Noktası
- `runningSubagents` haritasını ve `latestPi` referansını tutar.
- `subagentsExtension(pi: ExtensionAPI)` fonksiyonu içinde `session_start`, `session_shutdown` kancalarını ve `tools/subagent-tools.ts` ile `tui/message-renderers.ts` kayıtlarını bağlar (~60-80 satır).
- Aşağıdaki 43 baseline sembolün tamamını re-export eder:
  - **Fonksiyonlar (32):** `getAgentConfigDir`, `getBundledAgentsDir`, `getFrontmatterValue`, `parseCommaList`, `parseOptionalBoolean`, `parseSystemPromptMode`, `parseAgentDefinition`, `loadAgentDefaults`, `discoverAgentDefinitions`, `getArtifactDir`, `getDefaultSessionDirFor`, `resolveSubagentPaths`, `buildSubagentEnv`, `buildScriptPreamble`, `buildSubagentCliParts`, `buildSubagentCommand`, `composeSubagentTask`, `buildSkillPromptArgs`, `writeTaskArtifact`, `writeResumeMessageArtifact`, `computeUniqueName`, `findSubagentByName`, `formatElapsed`, `borderLine`, `borderTop`, `borderBottom`, `statusLabelFor`, `renderSubagentWidgetLines`, `resolveResultPresentation`, `attachSubagentWatcher`, `steerSubagent`, `default`.
  - **Tipler / Arayüzler (11):** `AgentDefaults`, `ListedAgentDefinition`, `SubagentLaunchDetails`, `SubagentsListDetails`, `SubagentMessageDetails`, `SubagentQuestionDetails`, `SubagentResultDetails`, `SubagentEnvOptions`, `SubagentCliOptions`, `RunningSubagent`, `SubagentResult`.

---

## 4. Aşama 3: Güvenlik ve Doğrulama Kapıları
1. **Tip Denetimi:** `npx tsc -p tsconfig.json --noEmit` -> exit code 0.
2. **Birim Testleri:** `npm test` -> 83 birim testinin tamamı yeşil.
3. **Export Eşitliği:** `git show HEAD:pi-extension/subagents/index.ts` ile yeni `index.ts` dışa aktarımlarının tam uyuştuğunu kontrol et.
4. **Davranış Kayması Denetimi:** `scout` alt ajanı ile tüm değişiklik kümesinde davranış kayması (behavior drift) taraması yaptır.
