// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

/**
 * Show the active sort on a results table's `<th class="sortable">` headers:
 * the sorted column gets a sort-asc / sort-desc class and an up / down arrow,
 * every other sortable column a neutral arrow. Shared by the SCR Events,
 * Correlation Matrix, Road Arousal and Junctions tables.
 *
 * @param {string} tableId
 * @param {string|null|undefined} column - data-sort key of the sorted column
 * @param {'asc'|'desc'} direction
 */
export function updateSortHeaders(tableId, column, direction) {
  if (
    typeof document === 'undefined' ||
    typeof document.getElementById !== 'function'
  )
    return;
  const table = document.getElementById(tableId);
  if (!table || typeof table.querySelectorAll !== 'function') return;

  table.querySelectorAll('thead th.sortable').forEach((th) => {
    const icon = th.querySelector('.sort-icon');
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === column) {
      th.classList.add(direction === 'desc' ? 'sort-desc' : 'sort-asc');
      if (icon) {
        icon.className =
          'fa-solid ' +
          (direction === 'desc' ? 'fa-sort-down' : 'fa-sort-up') +
          ' sort-icon';
      }
    } else if (icon) {
      icon.className = 'fa-solid fa-sort sort-icon';
    }
  });
}
