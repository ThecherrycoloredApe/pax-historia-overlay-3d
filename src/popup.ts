/**
 * Popup de l'extension : les trois réglages globaux. La liste des structures
 * (états, recherche, localisation) vit désormais SUR la carte — bouton 🏗️ en
 * haut à gauche de la partie.
 */

const content = document.getElementById('content')!;
const toggle = document.getElementById('toggle') as HTMLInputElement;
const toggleLabels = document.getElementById('toggle-labels') as HTMLInputElement;
const toggleModels = document.getElementById('toggle-models') as HTMLInputElement;

async function init(): Promise<void> {
  const settings = await chrome.storage.local.get(['overlayEnabled', 'hideGameLabels', 'models3d']);
  toggle.checked = settings['overlayEnabled'] !== false;
  toggle.addEventListener('change', () => {
    chrome.storage.local.set({ overlayEnabled: toggle.checked }).catch(() => {});
  });
  toggleLabels.checked = settings['hideGameLabels'] !== false;
  toggleLabels.addEventListener('change', () => {
    chrome.storage.local.set({ hideGameLabels: toggleLabels.checked }).catch(() => {});
  });
  toggleModels.checked = settings['models3d'] !== false;
  toggleModels.addEventListener('change', () => {
    chrome.storage.local.set({ models3d: toggleModels.checked }).catch(() => {});
  });

  content.innerHTML =
    '<p class="hint">📍 La liste des structures (chantiers, construites, ruines) est sur la carte : bouton 🏗️ en haut à gauche d\'une partie — avec recherche et localisation au clic.</p>';
}

init().catch(() => {
  content.innerHTML = '<p class="hint">Erreur de lecture du stockage.</p>';
});
