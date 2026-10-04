# Isoclock

**Offline data reduction for LA-ICP-MS U–Th–Pb dating of minerals with variable common Pb** —
apatite, titanite, wolframite and other hydrothermal or accessory phases.

Isoclock takes raw mass-spectrometer files through the whole workflow: data import and
inspection → background correction and outlier filtering → common-Pb correction on the
reference material → downhole fractionation calibration → Sample-Standard-Bracketing
ages. It runs from the command line or through a GUI, reads raw files from Thermo,
Agilent and Element instruments, and can be extended with further export formats.

> **Fork notice.** This repository is a maintained fork of
> [sndjgm/Isoclock](https://github.com/sndjgm/Isoclock). The software and the scientific
> method are by **Guoqi Liu** (East China University of Technology, sndjgm@foxmail.com).
> The numerical pipeline is unchanged. This fork adds packaging, documentation and a
> browser-based distribution.
> See [Notes on this fork](#notes-on-this-fork).

---

## No Python? Use the browser version

There is a **single-file, zero-dependency web version** of the whole reduction chain
under [`webgui/`](webgui/) — no install, no server, works offline. Same numbers as the
desktop program, verified **bit-for-bit** with the 207Pb/206Pb switch set to match
(439 automated comparisons in 14 suites + 62 in-page checks) — see [Notes for users](#notes-for-users).
Open it online at <https://chengkaide.github.io/Isoclock/app/isoclock.html>,
download [`webgui/isoclock.html`](webgui/isoclock.html) and double-click it, or read
[`webgui/README.md`](webgui/README.md) for how it was verified and what it does **not** do.

It adds two things the desktop program does not have: a **batch quality report**
(standard QC / sample summary / anomaly list / documented thresholds, exported as one
HTML file) and a **compatibility reader** for real-world Thermo exports whose headers
differ from the manual.

📖 **中文项目站点：<https://chengkaide.github.io/Isoclock/>** — 包括一份 8 章 56 图的
《原理与代码解读》图解教程，用中文把 U–Pb 定年、普通铅校正和这套软件每一步讲清楚。

---

## Quick start

```bash
git clone https://github.com/sndjgm/Isoclock.git     # or download the ZIP
cd Isoclock

python -m pip install -r requirements.txt            # install dependencies
python Isoclock2.0.py                                # start the program
```

Notes:

- **Python 3.9** — the version this software is developed and tested with.
  On Windows use `py -3.9 -m pip install -r requirements.txt`.
- **macOS / Linux** — use `python3`, and install Tk first
  (`sudo apt install python3-tk`, or `brew install python-tk`). Without it you get
  `ModuleNotFoundError: No module named 'tkinter'`.
- **Windows without Python** — run the prebuilt `Isoclock 2.0.exe`, see [Downloads](#downloads).
- Downloading the ZIP gives a folder named `Isoclock-main`, so adjust the `cd` above,
  or rename it to `Isoclock`.

### Read this before your first run

These four points cause most of the errors new users run into:

1. **The input and output folders must be different.** The program will not run otherwise.
2. **The input folder must contain the raw signal files and nothing else.** Any other file
   (an unrelated CSV, for instance) makes it stop with an error.
3. **Process one batch per run.** Restart the program and choose a new output folder before
   starting the next batch.
4. **The raw data must contain 204Pb, 206Pb, 207Pb, 208Pb, 232Th and 238U.** A missing
   channel causes an error.

## Workflow

```mermaid
flowchart TD
    A["(1)-(2) Choose calculation mode"] --> B["(3)-(4) Set reference material"]
    B --> C["(5) Choose instrument"]
    C --> D["(6) Set input / output paths, then Load Data"]
    D --> E["(7) Set background and integration intervals"]
    E --> F["(8) Fractionation Correction"]
    F --> G["(9) Export Liner / Average"]
    F -.-> H["result_all.csv, Mean_Cps.csv"]
    G -.-> I["cal_age_result_L*.xls / _A*.xls"]
```

The same steps click by click. The numbers match the labelled areas of the interface
(user manual, Fig. 3):

| # | Area | What to do |
|---|---|---|
| (1)–(2) | Calculation mode | Choose **standard Cor** if the reference material carries appreciable common Pb (apatite, titanite, wolframite …), **standard not Cor** otherwise (most zircon). The dark-blue block selects the common-Pb correction method: 207Pb and 204Pb after Chew et al. (2014), 208Pb after Zack et al. (2011). |
| (3)–(4) | Reference material | **Setting Standard** → **S&K** (Stacey & Kramers, 1975) or **User**. The reference-material name must match the name shown by the software exactly. |
| (5) | Instrument | **Thermo** (no list file needed, names are read automatically), **Agilent** (`sequence.csv` in the `sequence.d` folder, plus a list file — see below), **Element** (`.fin` holds the sequence, `.fin2` the signal data). |
| (6) | Input / output | Set both paths, then **Load Data**. With **Agilent** a file dialog opens — select the list file there. |
| (7) | Background & integration | Click a sample in the left-hand list to draw its signal, then **Set (All)** or **Set (Single)** to define the background and signal windows. |
| (8) | Ratios | **Fractionation Correction** writes `result_all.csv` and `Mean_Cps.csv` to the output folder. |
| (9) | Ages | **Export (Liner)** applies Sample-Standard-Bracketing with instrument-drift correction and writes `cal_age_result_L*.xls`. **Export (Average)** writes `cal_age_result_A*.xls` without drift correction. |

**Agilent list file.** An Excel workbook whose worksheet must be named `Sheet1`; column 1
is the folder or file name, column 2 is the sample or reference-material name.

**Converting Thermo exports.** `Thermo_to_Agilent_Convertdata.py` rewrites Thermo output
into the Agilent layout, if you prefer to work that way.

## Output files

| File | Content |
|---|---|
| `result_all.csv` | Per-sample isotope ratios and ages. First line is the header. |
| `Mean_Cps.csv` | Mean count rates per sample, per channel. |
| `cal_age_result_L*.xls` | Ages and ratios with Sample-Standard-Bracketing drift correction (Liner). |
| `cal_age_result_A*.xls` | The same without drift correction (Average). |
| Signal diagrams | Written to the output folder as each sample is selected in step (7). |

See the manual for a description of the columns (Fig. 4).

## Downloads

| Item | Where |
|---|---|
| Video walkthrough | https://www.youtube.com/watch?v=-MocFvCSmBc |
| User manual, v2.0 | [`User manuals of Isoclock v2.0 .pdf`](<User manuals of Isoclock v2.0 .pdf>) — in this repository |
| User manual, extended | [`Isoclock user manual_20231001222453.pdf`](<Isoclock user manual_20231001222453.pdf>) — in this repository |
| Prebuilt Windows `.exe` | https://www.researchgate.net/publication/371012414_Isoclock20 |
| Demo video | https://www.researchgate.net/publication/371039144_Demo_of_Isoclock20 |

The `.exe` is distributed through ResearchGate, as documented in the user manual. The
OneDrive mirrors previously listed here no longer resolve to a direct download — they now
land on a Microsoft sign-in page — so they have been dropped. If you cannot reach the
`.exe` package, run the software from source: it needs nothing beyond `requirements.txt`.

## Notes for users

Points worth knowing when interpreting results. They describe how the pipeline behaves —
they are not differences introduced by this fork, since the numerical output is identical
in both.

1. **207Pb/206Pb ages** (`Age76Pb`) are computed by a fixed 10-iteration refinement. Below
   about 600 Ma they agree with a converged solution to better than 1e-4 relative; for
   Proterozoic samples the two diverge, by roughly 35 Ma (1.7%) near 2.1 Ga. The 206Pb/238U
   and 207Pb/235U ages have closed-form solutions and are unaffected, so they make a useful
   cross-check. In the browser version this is a switch: convergence-based iteration is on
   by default, and clearing it reproduces the desktop values bit for bit.
2. **The 204Pb correction methods** need a non-zero net count rate on mass 204. If your
   data have none, use the 207Pb or 208Pb methods instead.
3. **204Hg interference.** Whether mass 204 needs a Hg correction depends on how your
   instrument software exported the data. If the export has not already been corrected for
   Hg, the 204Pb-based methods and the 208Pb/204Pb column will be biased — worth checking
   how your data were exported.

Questions about this fork are welcome in the issue tracker.

## Notes on this fork

The numerical pipeline is unchanged, and the scientific method is entirely the original
author's. What this fork adds is packaging, documentation, distribution, and a browser
version of the whole chain.

| Change | Result |
|---|---|
| Five near-identical reduction functions merged into one shared skeleton (500 lines fewer) | Same behaviour, verified bit-for-bit across 690 output cells |
| `loaddata` reads only the 8 columns it needs, as `float` | 39 ms to 9.5 ms per sample (4.1×) |
| `requirements.txt` reduced to the packages actually required | `pip install -r` succeeds in a fresh environment |
| Licence file completed to the full Apache 2.0 text | Recognised by GitHub and Zenodo |
| Converter output names derived by string handling | No file-name string is executed |
| Errors reported with tracebacks, including from packaged builds | Failures are visible while running |
| Unused imports removed | Fewer transitive dependencies |
| **Single-file, zero-dependency browser version added** (`webgui/`) | No install, no server, works offline; same numbers as the desktop program |

## References

Chew, D.M., Petrus, J.A., Kamber, B.S., 2014. U–Pb LA–ICPMS dating using accessory mineral
standards with variable common Pb. *Chemical Geology* 363, 185–199.

Stacey, J.S., Kramers, J.D., 1975. Approximation of terrestrial lead isotope evolution by a
two-stage model. *Earth and Planetary Science Letters* 26, 207–221.

The 208Pb correction method follows Zack et al. (2011).

## License and citation

Released under the Apache License 2.0 — see [LICENSE](LICENSE).

Citation metadata is in [CITATION.cff](CITATION.cff); GitHub's *Cite this repository* button
reads it directly.
