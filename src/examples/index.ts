export interface Example {
  id: string;
  name: string;
  source: string;
}

export const EXAMPLES: Example[] = [
  {
    id: 'led',
    name: 'LED + resistor',
    source: `# The simplest circuit: an LED with a series resistor.
# Format: REF FOOTPRINT [VALUE] pin=NET ...
J1 header2 PWR 1=VCC 2=GND
R1 axial(4-6) 330R 1=VCC 2=A
D1 radial(1) LED 1=A 2=GND
`,
  },
  {
    id: '555',
    name: '555 LED flasher',
    source: `# NE555 astable LED flasher.
# 555 pins: 1 GND, 2 TRIG, 3 OUT, 4 RESET, 5 CTRL, 6 THR, 7 DIS, 8 VCC
J1 header2 PWR 1=VCC 2=GND
U1 dip8 NE555 1=GND 2=THR 3=OUT 4=VCC 5=CV 6=THR 7=DIS 8=VCC
R1 axial(4-8) 1k 1=VCC 2=DIS
R2 axial(4-8) 47k 1=DIS 2=THR
C1 radial(2) 10u 1=THR 2=GND
C2 radial(1) 10n 1=CV 2=GND
R3 axial(4-8) 470R 1=OUT 2=LED_A
D1 radial(1) LED 1=LED_A 2=GND
`,
  },
  {
    id: 'astable',
    name: 'Transistor astable',
    source: `# Two-transistor astable multivibrator (alternately flashing LEDs).
# BC547 (TO-92): pin 1 = C, 2 = B, 3 = E. LED pin 1 = anode.
J1 header2 PWR 1=VCC 2=GND
Q1 to92 BC547 1=C1 2=B1 3=GND
Q2 to92 BC547 1=C2 2=B2 3=GND
R1 axial(4-8) 470R 1=VCC 2=LED1
D1 radial(1) LED 1=LED1 2=C1
R4 axial(4-8) 470R 1=VCC 2=LED2
D2 radial(1) LED 1=LED2 2=C2
R2 axial(4-8) 47k 1=VCC 2=B2
R3 axial(4-8) 47k 1=VCC 2=B1
C1 radial(2) 10u 1=C1 2=B2
C2 radial(2) 10u 1=C2 2=B1
`,
  },
  {
    id: 'sallen-key',
    name: 'TL072 low-pass filter',
    source: `# Single-supply 2nd-order Sallen-Key low-pass filter with a buffered mid-rail.
# TL072 pins: 1 OUTA, 2 -INA, 3 +INA, 4 V-, 5 +INB, 6 -INB, 7 OUTB, 8 V+
J1 header2 PWR 1=VCC 2=GND
J2 header3 IO 1=IN 2=OUT_AC 3=GND
R1 axial(4-8) 100k 1=VCC 2=VREF
R2 axial(4-8) 100k 1=VREF 2=GND
C1 radial(2) 10u 1=VREF 2=GND
U1 dip8 TL072 1=VMID 2=VMID 3=VREF 4=GND 5=SK_B 6=OUT 7=OUT 8=VCC
C2 radial(2) 1u 1=IN 2=SK_IN
R5 axial(4-8) 100k 1=SK_IN 2=VMID
R3 axial(4-8) 10k 1=SK_IN 2=SK_A
R4 axial(4-8) 10k 1=SK_A 2=SK_B
C3 radial(1) 10n 1=SK_A 2=OUT
C4 radial(1) 4n7 1=SK_B 2=VMID
C5 radial(2) 1u 1=OUT 2=OUT_AC
C6 radial(1) 100n 1=VCC 2=GND
`,
  },
  {
    id: 'lm386',
    name: 'LM386 amplifier',
    source: `# LM386 audio amplifier, gain 200, with volume pot and Zobel network.
# LM386 pins: 1 GAIN, 2 -IN, 3 +IN, 4 GND, 5 VOUT, 6 VS, 7 BYPASS, 8 GAIN
J1 header2 PWR 1=VCC 2=GND
J2 header2 IN 1=IN 2=GND
J3 header2 SPK 1=SPK 2=GND
RV1 pot 10k 1=IN 2=WIPER 3=GND
U1 dip8 LM386 1=G1 2=GND 3=WIPER 4=GND 5=VOUT 6=VCC 7=BYP 8=G8
C1 radial(1) 10u 1=G1 2=G8
C2 radial(2) 10u 1=BYP 2=GND
C3 radial(1) 100n 1=VCC 2=GND
C4 radial(1) 47n 1=VOUT 2=ZOB
R1 axial(4-6) 10R 1=ZOB 2=GND
C5 radial(3) 220u 1=VOUT 2=SPK
C6 radial(2) 100u 1=VCC 2=GND
`,
  },
];
