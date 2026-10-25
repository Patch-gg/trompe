# Spike: which fal models can texture a level by projection?

Throwaway test, run 2026-10-24, to choose default models and check the core loop before building the app.
It covers two blockout levels, a Mediterranean courtyard and an industrial hall, built in headless Blender.

Each run is a chain of four cameras:
1. **v1** goes from a lit gray render to a photo, which is projected onto the mesh.
2. **v2** and **v3** see that texture plus gray clay. The model fills in the clay, we paste the known pixels
   back, and the result is projected.
3. **v4** is held out and only renders the final texture.

There are 71 fal calls in all, about $3 at listed prices.

## Results

![hybrid chains, interior](out/sheet_hybrid_interior.jpg)

| chain | first view: edges lost | first view: drift | fill: kept-area ΔE | fill: seam, hard → feathered | s / 3 views | $ / 3 views |
|---|---|---|---|---|---|---|
| **FLUX 3 Klein + Fibo 2 (default)** | 0.6% | 4 px | 0.9 | 1.48 → 1.23 | 31 | 0.09 |
| Ideogram 4.5 + Fibo 2 | 0.1% | 2 px | 0.9 | 1.49 → 1.19 | 43 | 0.14 |
| FLUX 3 Klein alone | 0.6% | 4 px | 7.3 | 1.73 → 1.53 | 10 | 0.03 |
| Ideogram 4.5 alone | 0.1% | 2 px | 0.6 | 1.39 → 1.17 | 48 | 0.18 |
| Nano Banana 2.1 alone | 4.6% | 5 px | 4.6 | 1.63 → 1.39 | 49 | 0.15 |
| FLUX 3 alone | 0.5% | 3 px | 3.5 | 1.94 → 1.83 | 127 | 0.14 |
| Qwen Image 3 alone | 2.3% | 23 px | 14.1 | 1.91 → 1.11 | 109 | 0.12 |
| Fibo 2 alone | 13.4% | 28 px | 1.0 | 1.31 → 1.17 | 43 | 0.12 |
| GPT Image 2.5 alone | 26.8% | 33 px | 8.2 | 2.00 → 1.46 | 47 | 0.15 |

Full table: [out/metrics.md](out/metrics.md). Metric definitions are in [metrics.py](metrics.py):
- **Edges lost:** real geometry edges with no matching edge in the output.
- **Drift:** global shift between the gray render and the output.
- **Kept-area ΔE:** how much the model changed pixels it should have left alone.
- **Seam:** gradient across the paste boundary relative to its surroundings, where 1.0 means invisible.

## What we learned

1. **Models split into two groups.**
   - FLUX 3 Klein, FLUX 3, Ideogram 4.5 and Nano Banana 2.1 keep the camera and geometry.
   - GPT Image 2.5, and Fibo 2 when it generates a full frame, recompose the shot. The images look great, but
     13–27% of geometry edges go missing and the texture smears once it's projected.
2. **First view: FLUX 3 Klein.** It's nearly as faithful as the best (0.6% edges lost), takes 3.4 s against
   14–46 s for the others, and costs $0.009 per image.
3. **Fills: Fibo 2 with a mask.** It leaves unmasked pixels almost untouched and gives the best continuation.
   That holds only for masked fills: on the first view Fibo 2 drifts badly.
4. **Paste known pixels back, then fade over 6 px.** The fade cuts seam contrast by 10–40% for every model.
   Global colour matching made seams worse, so it's out.
5. **Quality-aware updates fix smearing.** Texels captured at a steep angle or from far away, at less than 0.4×
   the quality a later view offers, get regenerated instead of kept. That removes the streaky floors in v3. It
   also marks the floor near v4 as under-captured, which is exactly where the camera planner should add a view.
6. **Check for hallucinated objects with normals, not depth.** Fitting Marigold depth globally flags whole walls
   even on good outputs. Comparing Marigold normals (`fal-ai/marigold-v2`, $0.03) with the true geometry flags
   1.2% of an aligned view and 23% of a recomposed one, and it picks out painted-in 3D such as door recesses and
   a wall fountain's basin ([out/qa_normals_sheet.jpg](out/qa_normals_sheet.jpg)). The same normals can feed the
   detail normal maps.

**Caveats:** two small scenes, one seed per model, identical prompts for every model, and 3 views per chain.
FLUX 3 Klein's price is fal's listed "planned" price.

## Reproduce

```bash
blender -b -P blender/scenes.py -- exterior out    # ~20 s each on the 4090 (CUDA)
blender -b -P blender/scenes.py -- interior out
uv venv .venv && uv pip install --python .venv/bin/python numpy opencv-python-headless scipy pillow requests fal-client matplotlib
export FAL_KEY=your-fal-key
.venv/bin/python run.py --tag base                                         # all models, both scenes
.venv/bin/python run.py --tag hybrid --first flux3-klein --cont fibo2
.venv/bin/python run.py --tag hybrid-qa --first flux3-klein --cont fibo2 --quality-ratio 0.4
.venv/bin/python qa_normals.py
.venv/bin/python report.py                                                 # metrics.md + contact sheets
```

Generations are cached by input hash in `out/cache`, so reruns only pay for new inputs.
