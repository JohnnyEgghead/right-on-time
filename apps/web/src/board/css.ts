// SPDX-License-Identifier: AGPL-3.0-or-later
// The sheets SCR-OFC-02 loads, as its frame (office-board) does, in its order: the office surface's kit slices, then the
// page's own rules (DK-85, copied byte for byte), then the board's page adaptations (zero specificity; no compared value).
import '../shell/css/office.ts';
import '../../styles/page-office-board.css';
import '../../styles/app/board.css';
