// Example dumps for the doctor tab. Each is a GDB session as it would look on
// the board named, with one planted mistake. Values follow the reference
// manual layouts; none are copied from real firmware.

export interface DoctorExample {
  id: string;
  chip: string;
  label: string;
  question: string;
  dump: string;
}

export const DOCTOR_EXAMPLES: DoctorExample[] = [
  {
    id: 'blackpill-uart',
    chip: 'stm32f411',
    label: 'Black Pill: USART2 prints garbage',
    question: 'USART2 on PA2/PA3 prints garbage at 115200 baud',
    // HSE 25 MHz -> PLL 100 MHz, APB1 /2 = 50 MHz. BRR 0x8B was computed for 16 MHz.
    dump: `(gdb) x/3wx 0x40023800
0x40023800:	0x03037583	0x04403219	0x0000100a
(gdb) x/1wx 0x40023830
0x40023830:	0x00000001
(gdb) x/1wx 0x40023840
0x40023840:	0x10020000
(gdb) x/10wx 0x40020000
0x40020000:	0xa80000a0	0x00000000	0x0c0000f0	0x64000040
0x40020010:	0x0000c40c	0x00000000	0x00000000	0x00000000
0x40020020:	0x00007700	0x00000000
(gdb) x/4wx 0x40004400
0x40004400:	0x000000c0	0x00000000	0x0000008b	0x0000200c`,
  },
  {
    id: 'blackpill-pwm',
    chip: 'stm32f411',
    label: 'Black Pill: no PWM on PA0',
    question: 'TIM2_CH1 PWM on PA0 stays flat',
    // TIM2 CH1 PWM mode 1, PSC 99, ARR 999, CCR1 250 at 100 MHz; PA0 set to AF2 (TIM5) instead of AF1.
    dump: `(gdb) x/3wx 0x40023800
0x40023800:	0x03037583	0x04403219	0x0000100a
(gdb) x/1wx 0x40023830
0x40023830:	0x00000001
(gdb) x/1wx 0x40023840
0x40023840:	0x10000001
(gdb) x/1wx 0x40020000
0x40020000:	0xa8000002
(gdb) x/1wx 0x40020020
0x40020020:	0x00000002
(gdb) x/17wx 0x40000000
0x40000000:	0x00000081	0x00000000	0x00000000	0x00000000
0x40000010:	0x0000001f	0x00000000	0x00000068	0x00000000
0x40000020:	0x00000001	0x000001c2	0x00000063	0x000003e7
0x40000030:	0x00000000	0x000000fa	0x00000000	0x00000000
0x40000040:	0x00000000`,
  },
  {
    id: 'blackpill-led',
    chip: 'stm32f411',
    label: 'Black Pill: PC13 LED stays off',
    question: 'PC13 LED never lights',
    // GPIOC's clock was never enabled, so its registers read 0 and the MODER write was lost.
    dump: `(gdb) x/1wx 0x40023830
0x40023830:	0x00000001
(gdb) p/x *GPIOC
$1 = {MODER = 0x0, OTYPER = 0x0, OSPEEDR = 0x0, PUPDR = 0x0, IDR = 0x0, ODR = 0x0, BSRR = 0x0, LCKR = 0x0, AFR = {0x0, 0x0}}`,
  },
  {
    id: 'bluepill-uart',
    chip: 'stm32f103',
    label: 'Blue Pill: USART1 TX silent',
    question: 'USART1 TX on PA9 sends nothing at 115200',
    // 72 MHz from HSE 8 MHz x9. PA9 is a general-purpose push-pull output instead of AF push-pull.
    dump: `(gdb) x/1wx 0x40021004
0x40021004:	0x001d040a
(gdb) x/1wx 0x40021018
0x40021018:	0x00004005
(gdb) x/4wx 0x40010800
0x40010800:	0x44444444	0x44444434	0x0000a6ff	0x00000000
(gdb) x/4wx 0x40013800
0x40013800:	0x000000c0	0x00000000	0x00000271	0x0000200c`,
  },
];

export interface WriteExample {
  chips: string[];
  text: string;
}

export const WRITE_EXAMPLES: WriteExample[] = [
  { chips: ['stm32f411', 'stm32f407', 'stm32h743'], text: 'PA5 push-pull output, low speed, no pull' },
  { chips: ['stm32f411'], text: 'PC13 open-drain output for the Black Pill LED, no pull' },
  { chips: ['stm32f411'], text: 'USART2 115200 baud at 50 MHz APB1, 16x oversampling, TX and RX on' },
  { chips: ['stm32f411', 'stm32f407'], text: 'PA2 and PA3 alternate function AF7 for USART2, pull-up' },
  { chips: ['stm32f411', 'stm32f407'], text: 'TIM2 channel 1 PWM mode 1 at 1 kHz, 25% duty, timer clock 100 MHz' },
  { chips: ['stm32f103'], text: 'PC13 push-pull output 2 MHz' },
  { chips: ['stm32f103'], text: 'USART1 115200 baud at 72 MHz APB2' },
];
