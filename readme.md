# 🛡️ Lavka Quality Shield (v1.0.1)

### *"Why would anyone eat this? Like, actually why?"* — Personal Tier List & Anti-Trash Filter for [Yandex Lavka](https://lavka.yandex.ru/)

**Sup y'all, it's me, it's your boy.**

So basically, here is the situation. You open [Yandex Lavka](https://lavka.yandex.ru/) at 2 AM because you want something quick for the air fryer or a pack of pelmeni. You look at the website and you realize something completely insane: **there are literally zero user reviews and zero star ratings on the entire site.** None. Nothing.

You see a shiny `-46%` discount badge on a pack of dumplings, you buy it, you boil it, and it tastes like wet cardboard stuffed with mechanically separated mystery pigeon and soy protein. And the worst part? Three weeks later you forget what the box looked like and you buy the **exact same dogshit again**.

It is what it is. Or at least it *was*, until I built **Lavka Quality Shield**.

## 📺 Asmongold's Official Feature Breakdown

| Feature | What It Actually Does | Asmon's Take | 
| ----- | ----- | ----- | 
| **⭐ 1–5 Star Rating & Verdict Banner** | Injects a dark rating panel into `main[data-testid="good-page-desktop"]` and slaps a giant **Твой вердикт** banner right under the product title `h1[data-testid="product-title"]`. | *"If it's a 5-star gigachad steak, you know immediately. If it's 1-star garbage, it tells you right at the top of the page so you don't even scroll."* | 
| **💀 The Catalog Shadow Realm** | Scans every `div[data-testid="product-card"]` across the home page, categories, search, and `/recents` («Вы покупали»). | *"When you ban an item, it grays out the card in the catalog, puts a red dashed border around it, and slaps a literal skull emoji + your review note on the thumbnail. Get that shit out of my face."* | 
| **🛑 Add-to-Cart Idiot Guard** | Hooks `button[data-testid="snippet-control"]` (`useCapture: true`) on any 1–2 star or blacklisted item. | *"If you try to click 'Add to Cart' on a banned item while half-asleep, the browser literally stops you and reads your own past review back to your face. Actual lifesaver."* | 
| **🥩 Smart Ingredient & Keto Radar** | Parses `section[data-testid="ingredients-block"]` and `section[data-testid="traits-block"]` on the fly. | *"Exposes mechanically separated meat (ММО), soy protein fillers, starch, maltodextrin, palm oil, and high carbs (>20g/100g), while highlighting clean ingredients and Keto-friendly (≤5g carbs) food."* | 
| **⚖️ Real Price Per 1 KG / 1 L** | Calculates true cost per kilogram or liter from `span[data-testid="price-text"]` and `span[data-testid="product-amount"]`. | *"Stops the shrinkflation scam where they sell you 160 grams of chicken for 317 rubles and pretend it's cheap. Do the math, dood."* | 
| **🧟 React 18 Hydration Armor (v1.0.1)** | Multi-wave DOM reconciliation & 4-key product matching (`slug` + `productId` + `imageKey` + normalized title without soft hyphens `\u00ad`). | *"React 18 tried to wipe our textarea when you hit F5. We added hydration resync waves and explicit `.value` locking. React lost. Big dick code."* | 

## 🏷️ Built-in Quick Tags (One-Click Verdict)

No need to write an essay every time you eat something. Just click a chip:

* **🔥 Топ за свои деньги** — Certified hood classic, S-Tier value.

* **🥩 В аэрогриль / су-вид** — Comes out godlike in the air fryer or sous-vide water bath.

* **🥑 Кето / Мало углей** — Low-carb approved, zero sugar spike.

* **🧂 Пересолено** — Tastes like the Dead Sea.

* **💧 Водянистое / Резина** — 40% pumped water, rubber texture.

* **🤢 Химозный состав** — Half the periodic table in the ingredients list.

* **💀 Никогда не брать** — Instant permaban.

## 🚀 Installation (Takes 30 Seconds, Zero Bloat)

1. Download or clone this repository into a local folder on your PC.

2. Open Google Chrome and navigate to `chrome://extensions/`.

3. Flip the **Developer mode** (*Режим разработчика*) toggle in the top-right corner.

4. Click **Load unpacked** (*Загрузить распакованное расширение*) in the top-left corner and select the project folder.

5. Open [lavka.yandex.ru](https://lavka.yandex.ru/), click any product, and start judging your groceries.

## 🗂️ Project Architecture

* **`manifest.json`** — Chrome Extension Manifest V3 configuration (`storage` permission only, zero external servers, zero telemetry).

* **`content.js`** — Core engine: DOM & `ld+json` parser, 4-key database resolver, React 18 hydration resync waves, price-per-kg calculator, ingredient scanner, and catalog card decorator.

* **`styles.css`** — Dark-mode native-feeling styles for the product widget, header verdict banner, and grayscale catalog overlays.

* **`popup.html` & `popup.js`** — Toolbar dashboard showing total rated items, S-Tier count, Ban List filter, direct product links, and 1-click JSON Export/Import backup.

## 💬 Final Verdict

No cloud accounts. No monthly SaaS subscription to remember which dumplings sucked. No 500MB `node_modules` folder. Just pure vanilla JS running locally in your browser and saving your stomach and wallet.

**There it is dood. Let's fucking go.**