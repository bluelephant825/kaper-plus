import { App, MarkdownView, Notice, Plugin, TAbstractFile, TFile, TFolder, normalizePath, PluginSettingTab, Setting } from 'obsidian';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App as KaperApp } from './ui/App';
import { kaperEditorExtension } from './editor-extension';
import { FileLabelRewriter } from './file-label-rewriter';
import { ensureKaperFrontmatter, hasKaperFrontmatter, syncFileTags } from './frontmatter';
import { parseKaperYaml, serializeKaperYaml } from './parser/recipe-parser';
import { RecipeModel } from './parser/types';

interface KaperPluginSettings {
  cleanUpOnExit: boolean;
}

const DEFAULT_SETTINGS: KaperPluginSettings = {
  cleanUpOnExit: true,
};

const RIBBON_ICON = 'utensils-crossed';
const DEFAULT_BASE = 'Untitled';

function emptyRecipe(title = 'Untitled'): RecipeModel {
  return {
    version: 1,
    title,
    servings: 2,
    ingredients: { main: [] },
    steps: [],
    capabilities: new Map(),
  };
}

function starterBlock(title?: string): string {
  const yaml = serializeKaperYaml(emptyRecipe(title));
  return `\`\`\`kaper\n${yaml}\`\`\`\n`;
}

function joinPath(folder: string, name: string): string {
  return normalizePath(folder === '/' ? name : `${folder}/${name}`);
}

export default class KaperPlugin extends Plugin {
  settings!: KaperPluginSettings;
  private labelRewriter: FileLabelRewriter | null = null;
  private syncTimeouts = new Map<string, NodeJS.Timeout>();

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new KaperSettingTab(this.app, this));

    this.registerEditorExtension([kaperEditorExtension]);

    this.registerMarkdownCodeBlockProcessor('kaper', (source, el, ctx) => {
      const parsed = parseKaperYaml(source);

      const resolveImage = (path: string): string => {
        if (!path) return path;
        if (/^https?:\/\//i.test(path) || path.startsWith('data:')) return path;

        const file = this.app.metadataCache.getFirstLinkpathDest(path, ctx.sourcePath);
        if (file) {
          return this.app.vault.adapter.getResourcePath(file.path);
        }
        return path;
      };

      const root = createRoot(el);
      root.render(
        createElement(KaperApp, {
          filePath: ctx.sourcePath,
          recipe: parsed.recipe,
          parseError: parsed.parseError,
          resolveImage: resolveImage,
          mode: 'preview',
          onCookMode: () =>
            (this.app as any).commands.executeCommandById('kaper-plus:start-cooking')
        })
      );
    });

    this.labelRewriter = new FileLabelRewriter(this);
    this.app.workspace.onLayoutReady(() => this.labelRewriter?.start());

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        const file = this.app.workspace.getActiveFile();
        if (file && file.extension === 'md') {
          void this.syncTagsForFile(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('modify', (file: TAbstractFile) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        
        const existing = this.syncTimeouts.get(file.path);
        if (existing) clearTimeout(existing);

        this.syncTimeouts.set(
          file.path,
          setTimeout(async () => {
            this.syncTimeouts.delete(file.path);
            await this.syncTagsForFile(file);
          }, 2000)
        );
      })
    );

    this.addRibbonIcon(RIBBON_ICON, 'Create recipe', () => {
      void this.createRecipe();
    });

    this.addCommand({
      id: 'create-recipe',
      name: 'Create recipe',
      callback: () => {
        void this.createRecipe();
      },
    });

    this.addCommand({
      id: 'convert-to-recipe',
      name: 'Convert current note to recipe',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) {
          void this.convertToRecipe(file);
        }
        return true;
      },
    });

    this.addCommand({
      id: 'start-cooking',
      name: 'Start cooking (slideshow)',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) {
          void this.startCookingSlideshow(file);
        }
        return true;
      },
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  onunload() {
    this.labelRewriter?.stop();
    this.labelRewriter = null;
  }

  private async createRecipe(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    const folder: TFolder = activeFile?.parent ?? this.app.vault.getRoot();

    const fileName = this.uniqueFileName(folder.path, DEFAULT_BASE);
    const path = joinPath(folder.path, fileName);

    const initialContent = ensureKaperFrontmatter(starterBlock());

    const file = await this.app.vault.create(path, initialContent);
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
  }

  private async convertToRecipe(file: TFile): Promise<void> {
    const added = { frontmatter: false, block: false };

    await this.app.vault.process(file, (data) => {
      let updated = data;
      if (!hasKaperFrontmatter(updated)) {
        updated = ensureKaperFrontmatter(updated);
        added.frontmatter = true;
      }
      if (!updated.includes('```kaper')) {
        const trailing = updated.endsWith('\n') ? '' : '\n';
        updated = `${updated}${trailing}\n${starterBlock(file.basename)}`;
        added.block = true;
      }
      return updated;
    });

    if (!added.frontmatter && !added.block) {
      new Notice('Already a recipe.');
      return;
    }
    new Notice(
      `Converted to recipe${added.block ? ' (starter block added)' : ''}.`,
    );
  }

  private uniqueFileName(folderPath: string, base: string): string {
    const exists = (name: string) =>
      this.app.vault.getAbstractFileByPath(joinPath(folderPath, name)) !== null;

    let candidate = `${base}.md`;
    let i = 2;
    while (exists(candidate)) {
      candidate = `${base} ${i}.md`;
      i++;
    }
    return candidate;
  }

  private async syncTagsForFile(file: TFile) {
    try {
      const cache = this.app.metadataCache.getFileCache(file);
      const kaperValue = cache?.frontmatter?.kaper;
      const hasKaperFrontmatter = kaperValue !== undefined && kaperValue !== null && kaperValue !== '';

      const content = await this.app.vault.read(file);
      
      if (hasKaperFrontmatter || content.includes('```kaper')) {
        const newContent = syncFileTags(content);
        
        if (newContent !== content) {
          await this.app.vault.modify(file, newContent);
        }
      }
    } catch (err) {
      console.error('Failed to sync tags from Kaper block', err);
    }
  }

  private async startCookingSlideshow(recipeFile: TFile): Promise<void> {
    try {
      // @ts-ignore
      const slidesPlugin = this.app.internalPlugins?.plugins?.slides;
      if (!slidesPlugin?.enabled) {
        new Notice("Please enable the core Slides plugin in Obsidian settings.");
        return;
      }

      const content = await this.app.vault.read(recipeFile);
      const match = content.match(/```kaper\r?\n([\s\S]*?)```/);
      if (!match) {
        new Notice("No Kaper recipe block found in this note.");
        return;
      }

      const parsed = parseKaperYaml(match[1]);
      if (!parsed.recipe) {
        new Notice(`Recipe parse error: ${parsed.parseError || 'Invalid YAML'}`);
        return;
      }

      const recipe = parsed.recipe;
      const slidesMarkdown = this.generateSlidesMarkdown(recipe);

      const parentPath = recipeFile.parent ? recipeFile.parent.path : '';
      const tempFileName = `${recipe.title || 'Untitled'} (Slides).md`;
      const tempPath = joinPath(parentPath, tempFileName);

      const existingAbstractFile = this.app.vault.getAbstractFileByPath(tempPath);
      let tempFile: TFile;

      if (existingAbstractFile instanceof TFile) {
        tempFile = existingAbstractFile;
        const currentContent = await this.app.vault.read(tempFile);
        if (currentContent !== slidesMarkdown) {
          await this.app.vault.modify(tempFile, slidesMarkdown);
        }
      } else {
        tempFile = await this.app.vault.create(tempPath, slidesMarkdown);
      }

      // Open the temp file in preview mode
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(tempFile, { state: { mode: 'preview' } });
      this.app.workspace.setActiveLeaf(leaf, { focus: true });

      // Start the presentation once the view is ready.
      let retries = 15;
      const tryStartPresentation = () => {
        try {
          const revealEl = document.querySelector('.reveal');
          if (revealEl) {
            console.log('[kaper-plus] Presentation started successfully');
            return;
          }

          const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
          const viewType = activeView?.getViewType?.() ?? 'no-markdown-view';
          const viewMode = activeView?.getMode?.() ?? 'unknown';

          // List available slides commands
          const allCommands = (this.app as any).commands?.commands ?? {};
          const slidesCommands = Object.keys(allCommands).filter((id: string) => id.includes('slide'));

          console.log(`[kaper-plus] Attempt ${16 - retries}/15 — viewType: ${viewType}, viewMode: ${viewMode}, slides commands: [${slidesCommands.join(', ')}]`);

          const result = (this.app as any).commands.executeCommandById('slides:start');
          console.log(`[kaper-plus] executeCommandById returned: ${result}`);
        } catch (err) {
          console.error('[kaper-plus] Error in tryStartPresentation:', err);
        }

        retries--;
        if (retries > 0) {
          setTimeout(tryStartPresentation, 400);
        } else {
          console.warn('[kaper-plus] Exhausted all retries. Presentation did not start.');
        }
      };
      setTimeout(tryStartPresentation, 600);

      if (this.settings.cleanUpOnExit) {
        const cleanup = this.app.workspace.on('file-open', (openedFile) => {
          if (openedFile?.path !== tempPath) {
            this.app.vault.delete(tempFile).catch(err => {
              console.error("Failed to delete temp cooking file", err);
            });
            this.app.workspace.offref(cleanup);
          }
        });
        this.registerEvent(cleanup);
      }
    } catch (err) {
      console.error("Failed to start cooking slideshow", err);
      new Notice("Error starting slideshow.");
    }
  }

  private generateSlidesMarkdown(recipe: RecipeModel): string {
    const slides: string[] = [];

    // Slide 1: Title & Info
    let introSlide = `<div class="kaper-slides-intro">\n\n`;
    introSlide += `## ${recipe.title || 'Untitled Recipe'}\n\n`;
    if (recipe.coverImage) {
      if (/^https?:\/\//i.test(recipe.coverImage) || recipe.coverImage.startsWith('data:')) {
        introSlide += `![Cover Image](${recipe.coverImage})\n\n`;
      } else {
        introSlide += `![[${recipe.coverImage}]]\n\n`;
      }
    }
    
    const metaParts: string[] = [];
    metaParts.push(`<strong>Servings:</strong> ${recipe.servings}`);
    if (recipe.difficulty) {
      metaParts.push(`<strong>Difficulty:</strong> ${recipe.difficulty}`);
    }
    if (recipe.time) {
      const times: string[] = [];
      if (recipe.time.prep) times.push(`Prep: ${recipe.time.prep}`);
      if (recipe.time.cook) times.push(`Cook: ${recipe.time.cook}`);
      if (recipe.time.total) times.push(`Total: ${recipe.time.total}`);
      if (times.length > 0) {
        metaParts.push(`<strong>Time:</strong> ${times.join(' | ')}`);
      }
    }
    introSlide += `<p class="kaper-slides-intro-meta">${metaParts.join('  •  ')}</p>\n\n`;
    introSlide += `</div>`;
    slides.push(introSlide.trim());

    // Slide 2: Ingredients
    let ingredientsSlide = `## Ingredients\n\n`;
    
    const activeGroups = Object.entries(recipe.ingredients).filter(([_, items]) => items.length > 0);
    
    if (activeGroups.length === 1) {
      const [groupName, items] = activeGroups[0];
      const showGroupName = groupName !== 'main';
      if (showGroupName) {
        ingredientsSlide += `### ${groupName.charAt(0).toUpperCase() + groupName.slice(1)}\n\n`;
      }
      
      const useTwoColumns = items.length > 4;
      const columnClass = useTwoColumns ? 'kaper-slides-ingredients-2col-list' : 'kaper-slides-ingredients';
      ingredientsSlide += `<div class="${columnClass}">\n\n`;
      
      for (const item of items) {
        let line = `- `;
        if (item.amount) {
          line += `**${item.amount}** `;
        }
        if (item.unit) {
          line += `${item.unit} `;
        }
        line += item.name;
        if (item.sub) {
          line += ` *(${item.sub})*`;
        }
        if (item.optional) {
          line += ` *(optional)*`;
        }
        ingredientsSlide += `${line}\n`;
      }
      ingredientsSlide += `\n</div>\n\n`;
    } else if (activeGroups.length > 1) {
      // Calculate weight per group (items + 1 for the header) to split evenly
      const groupWeights = activeGroups.map(([, items]) => items.length + 1);
      const totalWeight = groupWeights.reduce((a, b) => a + b, 0);
      const halfWeight = totalWeight / 2;
      
      // Distribute groups into two columns
      let col1End = 0;
      let currentWeight = 0;
      for (let i = 0; i < activeGroups.length; i++) {
        if (currentWeight + groupWeights[i] <= halfWeight || i === 0) {
          currentWeight += groupWeights[i];
          col1End = i + 1;
        } else {
          break;
        }
      }
      
      const col1Groups = activeGroups.slice(0, col1End);
      const col2Groups = activeGroups.slice(col1End);
      
      ingredientsSlide += `<div class="kaper-slides-ingredients-2col-groups">\n`;
      ingredientsSlide += `<div class="kaper-col">\n\n`;
      ingredientsSlide += this.renderIngredientGroups(col1Groups);
      ingredientsSlide += `</div>\n`;
      ingredientsSlide += `<div class="kaper-col">\n\n`;
      ingredientsSlide += this.renderIngredientGroups(col2Groups);
      ingredientsSlide += `</div>\n`;
      ingredientsSlide += `</div>\n\n`;
    }
    
    if (activeGroups.length > 0) {
      slides.push(ingredientsSlide.trim());
    }

    // Slides 3+: Steps
    recipe.steps.forEach((step, index) => {
      let stepHeader = `## Step ${index + 1}${step.duration ? ` (${step.duration})` : ''}`;
      let stepSlide = `${stepHeader}\n\n`;
      
      stepSlide += `${step.title}\n\n`;

      if (step.image) {
        if (/^https?:\/\//i.test(step.image) || step.image.startsWith('data:')) {
          stepSlide += `![Step Image](${step.image})\n\n`;
        } else {
          stepSlide += `![[${step.image}]]\n\n`;
        }
      }

      if (step.ingredients && step.ingredients.length > 0) {
        stepSlide += `*Ingredients needed:* ${step.ingredients.join(', ')}\n\n`;
      }

      if (step.tip) {
        stepSlide += `> **Tip:** ${step.tip}\n\n`;
      }
      if (step.warning) {
        stepSlide += `> **Warning:** ${step.warning}\n\n`;
      }

      slides.push(stepSlide.trim());
    });

    return slides.join('\n\n---\n\n');
  }

  private renderIngredientGroups(groups: [string, import('./parser/types').IngredientAmount[]][]): string {
    let md = '';
    for (const [groupName, items] of groups) {
      md += `### ${groupName.charAt(0).toUpperCase() + groupName.slice(1)}\n\n`;
      for (const item of items) {
        let line = `- `;
        if (item.amount) {
          line += `**${item.amount}** `;
        }
        if (item.unit) {
          line += `${item.unit} `;
        }
        line += item.name;
        if (item.sub) {
          line += ` *(${item.sub})*`;
        }
        if (item.optional) {
          line += ` *(optional)*`;
        }
        md += `${line}\n`;
      }
      md += `\n`;
    }
    return md;
  }
}

class KaperSettingTab extends PluginSettingTab {
  plugin: KaperPlugin;

  constructor(app: App, plugin: KaperPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Clean up (delete) the temporary presentation file on exit')
      .setDesc('If enabled, the temporary cooking presentation file is deleted when switching away or exiting the slideshow.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.cleanUpOnExit)
          .onChange(async (value) => {
            this.plugin.settings.cleanUpOnExit = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
