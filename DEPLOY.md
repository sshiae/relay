# Деплой релея на Render (бесплатно, без карты, постоянный адрес)

Релей — это публичная «прокладка»: браузер заходит на неё, а твой ПК (агент)
сам к ней подключается изнутри по обычному HTTPS/443 (проходит через твой VPN).
Итог — **постоянный адрес `https://…onrender.com`, без обрывов, без карты**.

Нужно два бесплатных аккаунта (только почта): GitHub (чтобы залить код) и Render.

---

## 1. Залей папку `relay/` на GitHub

1. Заведи аккаунт на https://github.com (если нет) — только почта.
2. Создай **новый публичный репозиторий**, напр. `rd-relay`.
3. Загрузь в него **содержимое папки `relay/`** (кнопка **Add file → Upload files**):
   - `relay.js`
   - `package.json`
   - папку `public/` (внутри `login.html` и `viewer.html`)
   
   Проще всего — перетащить эти файлы/папку в окно загрузки. Структура в репозитории:
   ```
   relay.js
   package.json
   public/login.html
   public/viewer.html
   ```
4. **Commit changes**.

## 2. Разверни на Render

1. Заведи аккаунт на https://render.com (можно через GitHub) — карта не нужна.
2. **New +** → **Web Service** → **Build and deploy from a Git repository** →
   подключи GitHub → выбери репозиторий `rd-relay`.
3. Настройки:
   - **Region**: ближайший к тебе (меньше пинг).
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node relay.js`
   - **Instance Type**: **Free**
4. Раздел **Environment Variables** — добавь две:
   - `PASSWORD` = твой пароль входа (тот же, что в `.env`)
   - `AGENT_KEY` = значение из твоего `.env` (строка `AGENT_KEY=...`)
5. **Create Web Service** и дождись статуса **Live**.
6. Твой адрес будет вида: `https://rd-relay-xxxx.onrender.com`

## 3. Подключи ПК к релею

1. В файле `.env` на ПК впиши адрес релея (обязательно `wss://`, не `https://`):
   ```
   RELAY_URL=wss://rd-relay-xxxx.onrender.com
   ```
   `AGENT_KEY` там уже стоит — он должен совпадать с тем, что на Render.
2. Запусти:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\start-relay.ps1
   ```
   В окне появится «connected to relay» / «bridged; ready for viewers».
3. Открой `https://rd-relay-xxxx.onrender.com` в браузере (с любого устройства/сети),
   введи пароль — ты за своим ПК. Адрес постоянный, обрывов по времени нет.

---

## Полезное

- **Бесплатный Render засыпает** после 15 мин без трафика. Пока агент подключён —
  сервис бодрствует. После долгого простоя первый заход может подниматься ~30–60 сек.
- **Трафик**: у бесплатного плана ~100 ГБ/мес. H.264 экономит, простой не тратит
  ничего. Держи «Чёткость» 1280 — хватит надолго.
- **AGENT_KEY** — секрет: одинаковый в `.env` и на Render, никому не показывай.
  Сменить: поменяй в обоих местах.
- **Автозапуск 24/7**: добавь `scripts\start-relay.ps1` в Планировщик задач
  (триггер «При входе»), как в основном README.
- **Альтернатива Render — Koyeb** (koyeb.com, тоже почта/без карты, деплой из GitHub,
  адрес `*.koyeb.app`): шаги те же — Build `npm install`, Start `node relay.js`,
  переменные `PASSWORD` и `AGENT_KEY`.
- Если Render попросит **health check path** — укажи `/healthz`.
