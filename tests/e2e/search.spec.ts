/**
 * Search suggestions in the site's search box, in a real browser.
 *
 * The box is the core's, on every theme, so its keyboard behaviour is tested
 * the way someone uses it: type, arrow down, Enter. And with the list open,
 * axe checks the combobox wiring — an autocomplete that a screen reader cannot
 * follow is a regression on the accessibility work, not a feature.
 */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('suggestions: typing offers matching posts, and the keyboard opens one', async ({ page }) => {
  await page.goto('/about');
  const box = page.getByRole('combobox', { name: 'Search this site' });
  await box.fill('welc');
  const list = page.getByRole('listbox', { name: 'Suggestions' });
  await expect(list).toBeVisible();
  const option = list.getByRole('option', { name: /Welcome to AstroBaaS/ });
  await expect(option).toBeVisible();
  await expect(box).toHaveAttribute('aria-expanded', 'true');

  // The open list must pass the same WCAG 2.1 AA check as every page.
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).include('.ab-site-search').analyze();
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);

  await box.press('ArrowDown');
  await expect(box).toHaveAttribute('aria-activedescendant', 'ab-suggest-0');
  await expect(list.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  // Visible, not only announced: a 2px outline, since a pale tint alone fails 1.4.11.
  const outline = await list.getByRole('option').first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return `${cs.outlineStyle} ${cs.outlineWidth}`;
  });
  expect(outline).toBe('solid 2px');
  await box.press('Enter');
  await page.waitForURL('**/blog/welcome-to-astrobaas');
});

test('suggestions: Enter with nothing highlighted still searches, and Escape closes the list', async ({ page }) => {
  await page.goto('/about');
  const box = page.getByRole('combobox', { name: 'Search this site' });
  await box.fill('welc');
  await expect(page.getByRole('listbox', { name: 'Suggestions' })).toBeVisible();
  await box.press('Escape');
  await expect(box).toHaveAttribute('aria-expanded', 'false');
  await box.press('Enter');
  await page.waitForURL(/\/blog\?q=welc/);
});
