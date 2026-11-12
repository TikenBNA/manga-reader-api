# Где держать манга-сервер, чтобы он не выключался

Замер актуальности: **ноябрь 2026**. Цель — сервер доступен 24/7, бесплатно, без «засыпания».

## Короткий вывод

| Вариант | Всегда включён | Ресурсы | Что нужно от тебя | Риски |
|---|---|---|---|---|
| **Oracle Cloud Always Free** ⭐ | ✅ да, пока жив аккаунт | 2 OCPU ARM + 12 ГБ RAM, 200 ГБ диска, 10 ТБ трафика | аккаунт Oracle + карта для верификации (списаний нет) | правило простоя: если 7 дней CPU/сеть/память < 20%, инстанс могут забрать |
| **Google Cloud e2-micro** | ✅ да | 1 vCPU (burst), 1 ГБ RAM, 30 ГБ | аккаунт GCP + карта | 1 ГБ исходящего трафика в месяц, слабый CPU |
| **Hugging Face Spaces (Docker)** | ⚠️ обычно да, но засыпает после долгого простоя | 2 vCPU, 16 ГБ RAM, 50 ГБ | аккаунт HF (у тебя уже есть) | правила HF про NSFW, публичный iframe-домен |
| **Koyeb Free** | ✅ nano-инстанс | 256 МБ RAM, 2.5 ГБ диска | аккаунт + карта | 256 МБ может не хватить на каталог 20k работ |
| **Render Free** | ❌ засыпает через 15 минут | 512 МБ | аккаунт | не годится как «всегда включён» |
| **Fly.io / Railway / Heroku** | ❌ бесплатного тарифа больше нет | — | — | — |

**Рекомендация: Oracle Cloud Always Free** — единственный вариант, где бесплатно дают полноценную виртуалку без засыпания и с нормальным трафиком. Альтернатива без карты — Hugging Face Spaces (но с оговорками по правилам и засыпанию).

## Oracle: пошагово

1. Регистрация на https://www.oracle.com/cloud/free/ — нужна карта (снимают ~1 $ и возвращают, для проверки). Регион выбирай ближний (например, Frankfurt).
2. В консоли: **Compute → Instances → Create instance**
   - Image: **Ubuntu 24.04**
   - Shape: **VM.Standard.A1.Flex** (ARM), 2 OCPU / 12 ГБ (это всё ещё бесплатный лимит)
   - Boot volume: 50 ГБ
   - Скачай приватный SSH-ключ.
3. Открой порты: **Networking → VCN → Security Lists → Default** → добавь Ingress `0.0.0.0/0` TCP **80** и **443** (22 уже открыт).
4. Подключись: `ssh -i <ключ> ubuntu@<публичный_ip>`
5. Бесплатный домен: зайди на https://www.duckdns.org, создай поддомен (например `tikenmanga`) и укажи в нём публичный IP инстанса.
6. Скопируй проект на сервер и запусти установщик:
   ```bash
   scp -i <ключ> -r manga-api ubuntu@<ip>:/tmp/manga-api
   ssh -i <ключ> ubuntu@<ip> 'sudo bash /tmp/manga-api/deploy/install-ubuntu.sh tikenmanga.duckdns.org'
   ```
7. Проверка: `https://tikenmanga.duckdns.org/health` и `https://tikenmanga.duckdns.org/demo`.

### Чтобы Oracle не забрал инстанс за простой

В консоли Oracle: **Instances → ... → Edit** и включи `Always Free`-совместимый режим нельзя, но правило простоя действует на CPU/сеть/память. Достаточно небольшой постоянной нагрузки:

```bash
# /etc/cron.d/manga-keepalive
*/2 * * * * root /usr/bin/curl -fsS http://127.0.0.1:3001/api/manga?page=2 >/dev/null 2>&1
*/5 * * * * root /usr/bin/sha256sum /dev/zero | head -c 2000000 > /dev/null 2>&1
```

Первый держит сеть и наш сервер в тонусе, второй даёт немного CPU.

## Hugging Face Spaces (если не хочешь карту)

1. Создай Space типа **Docker**, приватность выключена.
2. Залей содержимое `manga-api` (в репозитории уже есть `Dockerfile`; `sdk: docker` и `app_port: 3001`
   прописаны в YAML-шапке README — отдельный `PORT` задавать не нужно).
3. Адрес будет вида `https://<user>-<space>.hf.space` — он постоянный.
4. Чтобы не засыпал, повесь пинг раз в 30 минут (cron-job.org или отдельный GitHub Action).

Минусы: правила HF про взрослый контент, и Space может быть поставлен на паузу.

## После переноса

- Обнови `DEFAULT_URL` в `android/src/com/mangareader/app/MainActivity.java` и пересобери APK (`android/build.ps1`) — приложение будет открываться сразу на новом адресе.
- Локальный сторож (`MangaReaderTunnel`) можно выключить:
  ```powershell
  Disable-ScheduledTask -TaskName MangaReaderTunnel
  ```
- GitHub Pages-редирект оставить как резерв либо переписать на новый домен.
