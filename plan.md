# Plan: Zeilen-Abstand (Padding) zwischen den Textzeilen

> **Stand: umgesetzt (2025).** Entscheidung: **Option B** – fester, lockerer
> Abstand im „Beides“-Modus, passend zum „Nächste-Flug“-Modus; kein
> konfigurierbares `lineGap`. Neue Baselines (both): Ident 186, Höhe 254,
> Entfernung 322, Trennlinie y=348, Zähler 456. Sichtbare Zeilenlücken ~33–36 px
> (Default-Größen), ~21 px bei maximalen Größen – gemessen per Pixel-Band-Analyse,
> keine Überlappungen. `tools/mock-data-server.js` ergänzt für deterministische
> Layout-Tests (synthetisches `aircraft.json` mit `alt_baro`).
> Falls doch Feintuning gewünscht wird: Option A (`lineGap`-Stepper) bleibt als
> Nachrüst-Pfad beschrieben.

## Problem

Im Modus **„Beides“** stehen die Textzeilen (Ident / Höhe / Entfernung) sehr dicht
untereinander: bei den Standard-Schriftgrößen (80/46/46) beträgt der sichtbare
Zeilenabstand nur ~10 px (Baseline-Differenz 56 px, Cap-Height der Folgezeile
~46 px). Auch bei größeren Schriftgrößen bleibt der Abstand konstant klein, weil
die Baselines fest verdrahtet sind. Im Modus „Nächstes Flugzeug“ ist es lockerer
(~30 px), aber auch dort fest.

## Aktuelle Geometrie (512 viewBox, Baselines)

**nearest:**
```
Jet        43–193   (cy 118, box 150)
Ident      288      (max 80)
Höhe       364      (max 80 → PI max 80, icon unbounded)
Entfernung 432
unterer Rand frei bis 512 (80 px)
```

**both:**
```
Jet        24–116   (cy 70, box 92)
Ident      186      (max 84)
Höhe       242      (max 64)
Entfernung 298      (max 64)
Trennlinie 330
Zähler     452      (84 px, Label 44)
unterer Rand frei: 60 px; Lücke Trennlinie→Zähler: ~62 px
```

## Option A: konfigurierbarer Zeilenabstand `lineGap` (empfohlen)

Neues Setting `lineGap` (Standard **8**, Bereich **0–24** für „Beides“, **0–40**
für „Nächster Flug“, Schritt 4) mit ±-Stepper im Property Inspector –
konsistent mit den Schriftgrößen-Steppern.

Rendering: Baselines werden um `lineGap` nach unten versetzt:

- **nearest:** Ident `288`, Höhe `364 + gap`, Entfernung `432 + gap`
  (bei gap 40: Entfernung-Baseline 472, Descender bis ~482, noch 30 px Rand ✓)
- **both:** Höhe `242 + gap`, Entfernung `298 + gap`, **Trennlinie rückt mit**
  von 330 auf **344** (fix; Zähler bleibt bei 452, Lücke 348→392 = 44 px ✓).
  Effektives Maximum in „Beides“: gap 24 → Entfernung-Baseline 322, Descender
  ~335, 9 px zur Trennlinie ✓.

Begründung für die Cap: in „Beides“ begrenzt die Kombination aus Trennlinie und
Zähler den verfügbaren Raum; ein einheitlicher Stepper mit modusabhängiger
Obergrenze (analog zu den Schriftgrößen) hält das Icon immer lesbar.

**Änderungen:**

1. `plugin.js`
   - `DEFAULTS_ADSB.lineGap = 8`
   - `normalizeSettings`: `s.lineGap = clampSize(s.lineGap, 0, 40, 8)`
   - `renderIcon`: Baselines aus `gap` ableiten; Trennlinie im „both“-Zweig auf
     344 (nur wenn gap > 0? – nein, einheitlich 344, sieht auch bei gap 0 gut aus)
2. `propertyInspector/adsb.html`
   - Stepper „Zeilenabstand“ (id `lineGap`), min 0, max 40, step 4,
     Startwert aus `settings.lineGap ?? 8`
   - `update()`-Payload um `lineGap` erweitern
3. `README.md`: Spalte im Konfigurations-Table + Hinweis zur modusabhängigen
   Obergrenze (40 / 24)

## Option B: fester Abstand, kein Setting

Baselines einmalig ~8–12 px weiter auseinander (gleiche Endpositionen wie Option A
mit gap 8, nur nicht anpassbar). Weniger Code, aber kein Feintuning pro Button.

## Option C: proportionale Zeilenhöhe

Baseline-Abstand = Faktor × Schriftgröße der Zeile (z. B. 1.35 × em).
Typografisch „richtig“, aber das Layout wird schwerer vorhersagbar, wenn der
User mehrere Schriftgrößen gleichzeitig ändert; mehr Regressionstests nötig.

## Empfehlung

**Option A** (mit Default 8) – gleiche UX wie die Schriftgrößen-Stepper,
Default löst das Dicht-Problem sofort, Bereich bleibt durch die Caps sicher.

## Testplan

1. `node --check` + Integrationstest (Mock) in allen Modi mit
   `lineGap: 0 / 8 / max` → SVG-Text-Baselines + Pixel-Band-Analyse
   (`rsvg-convert` + `magick txt:`) auf Überlappungen prüfen.
2. PI-Test: `tools/test-settings.js`-Flow um `lineGap` erweitern
   (didReceiveSettings → Icon ändert sich).
3. `bash tools/install.sh` + `diff -r` Quell- vs. Install-Kopie.

## Offene Fragen

- Soll `lineGap` auch den Abstand **Jet → Ident** beeinflussen?
  (aktuell nein; bei Bedarf separate Baseline-Formel für Ident)
- Default 8 oder 12? (12 wirkt im „Beides“-Modus schon sehr luftig)
