// Bio Mapping — GUI: input/timer callbacks, menus, options, converter flow.
//
// Render callbacks (draw_graph, biomap_render_callback, menu_render,
// options_render, conv_progress_render, conv_status_render) live in
// biomap_render.c for separation of presentation from control flow.
#include "biomap.h"

// ==========================================================================
// Input & timer callbacks — forward events to the app's message queue
// ==========================================================================

void biomap_input_callback(InputEvent* e, void* ctx) {
    PluginEvent ev = {.type = EventTypeKey, .input = *e};
    furi_message_queue_put((FuriMessageQueue*)ctx, &ev, FuriWaitForever);
}

void biomap_timer_callback(void* ctx) {
    PluginEvent ev = {.type = EventTypeTick};
    furi_message_queue_put((FuriMessageQueue*)ctx, &ev, 0);
}

// ==========================================================================
// Conversion status — shown after "Convert CSV to GPX" runs
// ==========================================================================
//
//  ┌─────────────────────────────┐
//  │  Converting...              │   ← shown during conversion
//  │  biomap_003.csv             │
//  └─────────────────────────────┘
//
//  ┌─────────────────────────────┐
//  │  Conversion OK              │   ← shown after conversion
//  │  CSV : biomap_003.csv       │
//  │  GPX : biomap_003.gpx       │
//  │  Points : 29                │
//  │  Press Back                 │
//  └─────────────────────────────┘

static void show_status_screen(BioMapApp* app, ConvResult* r) {
    ViewPort* vp = view_port_alloc();
    view_port_draw_callback_set(vp, conv_status_render, r);
    view_port_input_callback_set(vp, biomap_input_callback, app->event_queue);

    // Menu VP is already in the stack (disabled) — no flash when we add on top
    gui_add_view_port(app->gui, vp, GuiLayerFullscreen);
    view_port_update(vp);

    PluginEvent ev;
    while(furi_message_queue_get(app->event_queue, &ev, 0) == FuriStatusOk); // drain stale
    while(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) == FuriStatusOk) {
        if(ev.type == EventTypeKey && ev.input.type == InputTypeShort
            && ev.input.key == InputKeyBack) break;
    }

    // Remove status VP — menu VP is still underneath, no flash
    gui_remove_view_port(app->gui, vp);
    view_port_free(vp);
}

// ==========================================================================
// Launch menu — main navigation
// ==========================================================================
//
//  ┌─────────────────────────────┐
//  │  Bio Mapping                │
//  │  ▓ GPS + GSR           ▓   │   ← selected item (inverse bar)
//  │    GPS Only                 │
//  │    GSR Only                 │
//  │    Convert CSV to GPX       │
//  │    Options                  │
//  │                             │
//  └─────────────────────────────┘
//
//  Controls:  Up/Down → navigate     OK → select     Back → exit app

int32_t biomap_gui_show_menu(BioMapApp* app) {
    MenuContext ctx = {.app = app, .selection = 0};
    view_port_draw_callback_set(app->menu_vp, menu_render, &ctx);

    // Enable menu VP so it receives input and renders
    view_port_enabled_set(app->menu_vp, true);
    view_port_update(app->menu_vp);

    PluginEvent ev;
    int32_t result = -1;
    bool running = true;
    while(running) {
        if(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) != FuriStatusOk)
            continue;
        if(ev.type != EventTypeKey || ev.input.type != InputTypeShort) continue;

        switch(ev.input.key) {
        case InputKeyUp:
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            if(ctx.selection > 0) ctx.selection--;
            furi_mutex_release(app->mutex);
            view_port_update(app->menu_vp);
            break;
        case InputKeyDown:
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            if(ctx.selection < MENU_COUNT - 1) ctx.selection++;
            furi_mutex_release(app->mutex);
            view_port_update(app->menu_vp);
            break;
        case InputKeyOk:
            furi_mutex_acquire(app->mutex, FuriWaitForever);
            result = ctx.selection;
            furi_mutex_release(app->mutex);
            running = false;
            break;
        case InputKeyBack:
            result = -1;
            running = false;
            break;
        default: break;
        }
    }

    // Disable menu VP so it stops receiving input while sub-screen runs.
    // The VP stays in the GUI stack (no flash of desktop) but passes
    // input through to any VP layered on top.
    view_port_enabled_set(app->menu_vp, false);
    view_port_draw_callback_set(app->menu_vp, NULL, NULL);
    return result;
}

// ==========================================================================
// Options screen — Reset GPS, Auto-zoom toggle
// ==========================================================================
//
//  ┌─────────────────────────────┐
//  │  Options                    │
//  │  ▓ Reset GPS           ▓   │   ← selected
//  │    Auto-zoom GSR   ON      │
//  │    Backlight           ON  │
//  │                             │
//  │    Press Back to return     │
//  └─────────────────────────────┘
//
//  Controls:  Up/Down → navigate     OK → select/toggle     Back → return

void run_options_screen(BioMapApp* app) {
    OptionsContext ctx = {.app = app, .selection = 0};

    ViewPort* vp = view_port_alloc();
    view_port_draw_callback_set(vp, options_render, &ctx);
    view_port_input_callback_set(vp, biomap_input_callback, app->event_queue);
    gui_add_view_port(app->gui, vp, GuiLayerFullscreen);
    view_port_update(vp);

    PluginEvent ev;
    while(furi_message_queue_get(app->event_queue, &ev, 0) == FuriStatusOk); // drain stale
    while(furi_message_queue_get(app->event_queue, &ev, FuriWaitForever) == FuriStatusOk) {
        if(ev.type == EventTypeKey && ev.input.type == InputTypeShort) {
            if(ev.input.key == InputKeyBack) break;

            switch(ev.input.key) {
            case InputKeyUp:
                furi_mutex_acquire(app->mutex, FuriWaitForever);
                if(ctx.selection > 0) ctx.selection--;
                furi_mutex_release(app->mutex);
                break;
            case InputKeyDown:
                furi_mutex_acquire(app->mutex, FuriWaitForever);
                if(ctx.selection < OPTIONS_COUNT - 1) ctx.selection++;
                furi_mutex_release(app->mutex);
                break;
            case InputKeyOk:
                switch(ctx.selection) {
                case 0:
                    // Reset GPS — VP stays visible, no need to re-create
                    run_gps_hot_start(app);
                    view_port_update(vp);
                    continue;
                case 1:
                    // Toggle auto-zoom
                    furi_mutex_acquire(app->mutex, FuriWaitForever);
                    app->zoom.enabled = !app->zoom.enabled;
                    if(app->zoom.enabled) {
                        app->zoom.peak = 1.0f;
                        app->zoom.level     = 1.0f;  // reset stale manual zoom; lerp starts clean
                    }
                    furi_mutex_release(app->mutex);
                    break;
                case 2:
                    // Toggle backlight
                    furi_mutex_acquire(app->mutex, FuriWaitForever);
                    app->backlight_on = !app->backlight_on;
                    furi_mutex_release(app->mutex);
                    break;
                default: break;
                }
                break;
            default: break;
            }
            view_port_update(vp);
        }
    }

    gui_remove_view_port(app->gui, vp);
    view_port_free(vp);
}

// ==========================================================================
// Converter flow — scan CSVs, convert latest, show result
// ==========================================================================

void run_converter(BioMapApp* app) {
    GpxConverter* c = gpx_converter_alloc(app->storage);
    int n = gpx_converter_scan(c);

    ConvResult r = {.conv_ok = false, .conv_points = 0};

    if(n == 0) {
        strncpy(r.conv_name, "(none)", sizeof(r.conv_name) - 1);
        notification_message(app->notifications, &sequence_blink_red_100);
        show_status_screen(app, &r);
        gpx_converter_free(c);
        return;
    }

    const char* name = gpx_converter_get_name(c, n - 1);
    strncpy(r.conv_name, name, sizeof(r.conv_name) - 1);

    // Show "Converting..." while the two-pass conversion runs.
    // This prevents a blank screen during what could be seconds of I/O.
    ViewPort* prog_vp = view_port_alloc();
    view_port_draw_callback_set(prog_vp, conv_progress_render, &r);
    gui_add_view_port(app->gui, prog_vp, GuiLayerFullscreen);
    view_port_update(prog_vp);

    FURI_LOG_I("BioMap", "Converting %s", name);
    r.conv_points = gpx_converter_run(c, name, prog_vp);
    r.conv_ok = (r.conv_points > 0);
    notification_message(app->notifications,
        r.conv_ok ? &sequence_blink_green_100 : &sequence_blink_red_100);

    // Remove progress VP, show result
    gui_remove_view_port(app->gui, prog_vp);
    view_port_free(prog_vp);

    show_status_screen(app, &r);
    gpx_converter_free(c);
}

