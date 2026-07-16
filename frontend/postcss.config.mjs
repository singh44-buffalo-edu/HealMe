/**
 * PostCSS setup REQUIRED by Mantine 8 (CLAUDE.md §5 React): the preset
 * compiles Mantine's CSS syntax and simple-vars supplies the breakpoint
 * variables Mantine's own styles reference. The em values below are
 * Mantine's documented defaults — keep them in sync with Mantine, NOT with
 * the app's 767px shell switch (that lives in src/useIsMobile.ts and is
 * independent of these).
 */
import mantinePreset from 'postcss-preset-mantine';
import simpleVars from 'postcss-simple-vars';

const config = {
  plugins: [
    mantinePreset(),
    simpleVars({
      variables: {
        'mantine-breakpoint-xs': '36em',
        'mantine-breakpoint-sm': '48em',
        'mantine-breakpoint-md': '62em',
        'mantine-breakpoint-lg': '75em',
        'mantine-breakpoint-xl': '88em',
      },
    }),
  ],
};

export default config;
