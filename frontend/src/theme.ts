import { createTheme, type MantineColorsTuple } from '@mantine/core';

// Health green scale centered on brand #0F8A63 (index 6 = primary shade)
const hmdGreen: MantineColorsTuple = [
  '#e6f5ef',
  '#c9e9dc',
  '#9fd8c2',
  '#6fc4a4',
  '#43b088',
  '#219a72',
  '#0f8a63',
  '#0a6b4c',
  '#07543c',
  '#043e2c',
];

// Status colors for notifications/badges, anchored at design out-of-range #d64545 / watch #c7811b
const hmdRed: MantineColorsTuple = [
  '#fbefef',
  '#f8dede',
  '#efb6b6',
  '#e58b8b',
  '#dd6666',
  '#d64545',
  '#c33d3d',
  '#a83434',
  '#8d2b2b',
  '#732323',
];

const hmdAmber: MantineColorsTuple = [
  '#fdf9f1',
  '#fbf3e4',
  '#f3e3c8',
  '#e8cd9d',
  '#dcb672',
  '#d09c47',
  '#c7811b',
  '#a86d17',
  '#895913',
  '#6a450e',
];

const hmdIndigo: MantineColorsTuple = [
  '#efeffc',
  '#deddf9',
  '#c3c2f3',
  '#a5a3ec',
  '#8b89f2',
  '#6f6de9',
  '#5e5ce6',
  '#4b49c8',
  '#3c3aa4',
  '#2e2c80',
];

export const theme = createTheme({
  primaryColor: 'hmdGreen',
  primaryShade: 6,
  colors: { hmdGreen, hmdIndigo, hmdRed, hmdAmber },
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif",
  fontFamilyMonospace: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  headings: {
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif",
    fontWeight: '600',
    sizes: {
      h1: { fontSize: '26px', lineHeight: '32px' },
      h2: { fontSize: '17px', lineHeight: '24px' },
      h3: { fontSize: '15px', lineHeight: '22px' },
    },
  },
  defaultRadius: 'md',
  radius: { xs: '8px', sm: '10px', md: '12px', lg: '18px', xl: '20px' },
  shadows: {
    sm: '0 1px 3px rgba(0,0,0,.08)',
    md: '0 1px 2px rgba(0,0,0,.04), 0 8px 28px rgba(0,0,0,.05)',
    lg: '0 2px 4px rgba(0,0,0,.05), 0 12px 36px rgba(0,0,0,.08)',
  },
  black: '#1d1d1f',
  components: {
    Button: {
      defaultProps: { radius: 'xl' },
    },
    Badge: {
      defaultProps: { radius: 'xl' },
    },
    Paper: {
      defaultProps: { radius: 'lg', shadow: 'md' },
    },
  },
});
