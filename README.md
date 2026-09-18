# Isoclock
A novel off-line software for data reduction of LA-ICP-MS U-Pb dating with reference containing variable common Pb
Isoclock is designed to deduct common Pb for common-Pb-bearing materials and calibrate the U-Pb isotope fractionation. The software contains several processing steps for the raw files of mass spectrometry, such as data import and view, background correction and filtering of outliers, calculation of common Pb for reference materials, fractionation calibration, and age calculation. Isoclock is written using the free and open-source Python language and can either run the code directly or operate using a graphical interface. It is compatible with raw data files from widely used modern ICP-MS instruments and allows for extended data interfaces.



I. Software operation procedures

1.1 Start-up and functional block division

The following steps 1.1.1-1.1.5 is run before Isoclock runs for the first time.

1.1.1	Python 3.9 is necessary to run the code. Download from https://www.python.org/downloads/ and follow the installation.

1.1.2 Download or clone this repository.

1.1.3 Open terminal/cmd and navigate to the Isoclock folder.

 cd path/to/folder/ Isoclock

1.1.4 Install python libraries required for Isoclock.

	pip install -r requirements.txt

1.1.5 Run Isoclock from python.

	python Isoclock2.0.py

If everything is already installed, follow only steps1.1.5. If you are Windows user, you can also run the Isoclock.exe directly.

Instruction video:
https://www.youtube.com/watch?v=-MocFvCSmBc

Download user manual video:
https://1drv.ms/v/s!AjpkANeM2uTjmhahbMfLjdQhGS_U?e=WcoUTD

Download exe package for Windows:
https://onedrive.live.com/?authkey=%21AFzznagJI7etH5k&cid=E3E4DA8CD700643A&id=E3E4DA8CD700643A%213298&parId=root&o=OneUp



II. Known issues

The following problems are known and have not been fixed yet. They are
listed here so that results can be read with the necessary care.

1. 207Pb/206Pb age inversion (Age76Pb in Isoclock2.0.py).
   The convergence test is evaluated against a value computed before the
   loop and never updated, so the loop always runs a fixed 10 iterations.
   Compared with a high-precision solution the results are exact below
   about 600 Ma, but the deviation grows to roughly +35 Ma (1.7%) near
   2.1 Ga. Ages in the 1.5-2.2 Ga range should be treated with caution.

2. ZeroDivisionError in the 204Pb correction path.
   When the 204Pb method is selected and the net count rate of mass 204 is
   zero, the calculation stops with a ZeroDivisionError.

3. No Hg correction applied to mass 204.
   The term intended to remove the 204Hg contribution evaluates to zero
   (np.average(x) - np.average(x)) and its result is never used. This is
   harmless if the raw files have already been corrected for Hg by the
   instrument software; otherwise it biases the 204Pb correction methods
   and the 208Pb/204Pb column. Please check how your data were exported.

Corrections and bug reports are welcome.


