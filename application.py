App(
    appid="biomap",
    name="BioMapping 2.0",
    apptype=FlipperAppType.EXTERNAL,
    entry_point="biomap_app",
    requires=["gui", "storage"],
    stack_size=2 * 1024,
    order=10,
    fap_icon="biomap_icon.png", # Optional: Needs a 10x10 png
    fap_category="GPIO",
)