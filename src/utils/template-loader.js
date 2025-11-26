import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load HTML template from file
 * @param {string} templateName - Name of the template file (without .html extension)
 * @returns {Promise<string>} - Template content as string
 */
export async function loadTemplate(templateName) {
  try {
    const templatePath = join(__dirname, '..', 'templates', 'emails', `${templateName}.html`);
    const content = await readFile(templatePath, 'utf-8');
    return content;
  } catch (error) {
    logger.error({ error, templateName }, 'Failed to load email template');
    throw new Error(`Failed to load template: ${templateName}`);
  }
}

/**
 * Replace placeholders in template with actual values
 * @param {string} template - Template string with placeholders like {{placeholder}}
 * @param {Object} data - Object with key-value pairs to replace placeholders
 * @returns {string} - Template with replaced values
 */
export function renderTemplate(template, data) {
  let rendered = template;
  
  for (const [key, value] of Object.entries(data)) {
    const regex = new RegExp(`{{${key}}}`, 'g');
    rendered = rendered.replace(regex, value || '');
  }
  
  return rendered;
}

/**
 * Load and render template in one step
 * @param {string} templateName - Name of the template file
 * @param {Object} data - Data to replace placeholders
 * @returns {Promise<string>} - Rendered HTML
 */
export async function loadAndRenderTemplate(templateName, data) {
  const template = await loadTemplate(templateName);
  return renderTemplate(template, data);
}


