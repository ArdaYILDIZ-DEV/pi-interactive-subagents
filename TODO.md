# TODO: interactive-subagents Refaktör Uygulama Listesi

> **UYGULAYICI AJAN İÇİN ZORUNLU TALİMAT:**
> Bir dosyada herhangi bir değişiklik yapmadan önce, o dosyanın ve bağlantılı dosyaların tamamını `read` aracıyla mutlaka oku. Varsayımla kod yazma, sözleşmeyi ve 43 dışa aktarımı birebir koru. Detaylı mimari şema için `PLAN.md` ve `AGENTS.md` dosyalarını referans al.

---

## Aşama 1: Temizlik ve Yol Sertleştirmesi

- [ ] **1.1 `subagent-done.ts` - `agentStarted` bayrağını temizle**
  - Dosyayı oku: `pi-extension/subagents/subagent-done.ts` (satır 120-225).
  - Satır 127'deki `let agentStarted = false;` deklarasyonunu kaldır.
  - Satır 215'teki `agentStarted = true;` satırını kaldır.
  - Dosyada başka referansı olmadığını teyit et.

- [ ] **1.2 `discovery.ts` - `getBundledAgentsDir` ve arama yollarını sertleştir**
  - Dosyayı oku: `pi-extension/subagents/agents/discovery.ts`.
  - `getBundledAgentsDir` fonksiyonunu incele; `existsSync` kontrolüyle dizin varlığını doğrula ve güvenli fallback ekle.
  - Ajan arama önceliğinin `Proje (.pi/agents) > Global (~/.pi/agent/agents) > Paket (interactive-subagents/agents)` sırasını koruduğunu doğrula.

- [ ] **1.3 Aşama 1 Doğrulaması**
  - `npx tsc -p tsconfig.json --noEmit` çalıştır (exit 0 olmalı).
  - `npm test` çalıştır (83 test geçmeli).

---

## Aşama 2: `index.ts` Modüler Bölümleme

*Kural: `runningSubagents` ve `latestPi` referansları `index.ts` içinde kalır; yeni modüllere parametre/enjeksiyon olarak geçirilir. Bütün semboller `index.ts` üzerinden re-export edilir.*

- [ ] **2.1 `lifecycle/steer.ts` oluştur ve sembolleri taşı**
  - `index.ts` dosyasını oku (satır 566-616).
  - `steerSubagent` ve `handleSubagentSteer` fonksiyonlarını `lifecycle/steer.ts` içine taşı.
  - `index.ts`'ten re-export et.

- [ ] **2.2 `lifecycle/dispatcher.ts` oluştur ve sembolleri taşı**
  - `index.ts` dosyasını oku (satır 273-390).
  - `checkAskSidecar`, `attachSubagentWatcher`, `startStatusSupervision`, `startWidgetRefreshLater` fonksiyonlarını taşı.
  - `index.ts`'ten re-export et.

- [ ] **2.3 `lifecycle/launch.ts` oluştur ve sembolleri taşı**
  - `index.ts` dosyasını oku (satır 392-550).
  - `LaunchContext` ve `launchSubagent` fonksiyonunu taşı.
  - `index.ts`'ten re-export et.

- [ ] **2.4 `lifecycle/resume.ts` oluştur ve sembolleri taşı**
  - `index.ts` dosyasını oku (satır 618-742).
  - `resumeSubagent` fonksiyonunu taşı.
  - `index.ts`'ten re-export et.

- [ ] **2.5 `tui/message-renderers.ts` oluştur ve renderers taşı**
  - `index.ts` dosyasını oku (satır 1380-1430 civarı).
  - `subagent_question` ve `subagent_result` mesaj render fonksiyonlarını taşı.

- [ ] **2.6 `tools/subagent-tools.ts` oluştur ve tool kayıtlarını taşı**
  - `index.ts` dosyasını oku (satır 744-1197).
  - `subagent`, `subagents_list`, `subagent_message` araçlarını ve `/subagent` komut kaydını taşı.

- [ ] **2.7 `index.ts` dosyasını toparla**
  - Sadece durum haritası (`runningSubagents`), `latestPi`, `session_start` / `session_shutdown` kancaları ve 43 sembolün re-export'larını bırak (~60-80 satır).
  - `PLAN.md` içindeki 43 dışa aktarım listesiyle birebir karşılaştır.

---

## Aşama 3: Güvenlik ve Doğrulama Kapıları

- [ ] **3.1 Statik Tip Denetimi:** `npx tsc -p tsconfig.json --noEmit` çalıştır (exit 0).
- [ ] **3.2 Birim Testleri:** `npm test` çalıştır (83 test geçmeli).
- [ ] **3.3 Export Eşitliği:** `git show HEAD:pi-extension/subagents/index.ts` ile dışa aktarımları doğrula.
- [ ] **3.4 Davranış Kayması Denetimi:** Bağımsız `scout` alt ajanı çalıştırarak sıfır davranış kayması teyidi al.
