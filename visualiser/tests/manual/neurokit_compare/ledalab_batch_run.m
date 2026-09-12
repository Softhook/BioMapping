function ledalab_batch_run(ledalab_dir, work_dir, names_str)
% Runs the REAL MATLAB-source Ledalab (github.com/ledalab/ledalab), under
% Octave, in its own documented batch mode - no MATLAB license needed, see
% eda_detection_benchmark.md item 23 for how this was validated. Called by
% run_ledalab.py, not directly.
%
% For each comma-separated track name in names_str, expects two input files
% already written into work_dir by run_ledalab.py:
%   <name>_raw.txt          - unfiltered signal, for the "default" row
%   <name>_prefiltered.txt  - 0.5 Hz Butterworth pre-filtered, for the
%                             "literature-tuned" row (see item 22/23: naive
%                             point-deconvolution needs this pre-filter, and
%                             ledapy's numerics were confirmed faithful to
%                             this same real engine, so the same recipe
%                             applies here)
%
% Writes two output CSVs (peakTime,amp - the reconvolved-SCR amplitude, the
% same quantity export_scrlist.m applies its own amplitude criterion to)
% per track:
%   <name>_default_peaks.csv  - raw candidate list, optimize=0, no pre-filter
%   <name>_tuned_peaks.csv    - smoothwin_sdeco=0.5 on the pre-filtered input
%                               (the 0.1 uS amplitude floor is applied by the
%                               Python caller, not here, since it's a trivial
%                               post-filter on this file's own amp column)

addpath(genpath(ledalab_dir));
global leda2

names = strsplit(names_str, ',');

for i = 1:length(names)
  name = names{i};
  try
    % Default: raw signal, no smoothwin override, matches Ledalab's own
    % out-of-the-box CDA settings exactly.
    raw_file = fullfile(work_dir, [name, '_raw.txt']);
    Ledalab(raw_file, 'open', 'text', 'analyze', 'CDA', 'optimize', 0);
    n_default = length(leda2.analysis.peakTime);
    write_peaks(fullfile(work_dir, [name, '_default_peaks.csv']), ...
                leda2.analysis.peakTime, leda2.analysis.amp);

    % Tuned: pre-filtered signal, load without decomposing (analyze=none),
    % override smoothwin_sdeco, then decompose by hand - batch mode has no
    % hook to change this setting before sdeco() runs.
    tuned_file = fullfile(work_dir, [name, '_prefiltered.txt']);
    Ledalab(tuned_file, 'open', 'text', 'analyze', 'none', 'optimize', 0);
    leda2.set.smoothwin_sdeco = 0.5;
    sdeco(0);
    n_tuned = length(leda2.analysis.peakTime);
    write_peaks(fullfile(work_dir, [name, '_tuned_peaks.csv']), ...
                leda2.analysis.peakTime, leda2.analysis.amp);

    printf('ledalab_batch_run: %s done (%d default, %d tuned candidates)\n', ...
           name, n_default, n_tuned);
  catch err
    printf('ledalab_batch_run: error on %s: %s\n', name, err.message);
    write_peaks(fullfile(work_dir, [name, '_default_peaks.csv']), [], []);
    write_peaks(fullfile(work_dir, [name, '_tuned_peaks.csv']), [], []);
  end
end

end

function write_peaks(outfile, peak_times, amps)
  fid = fopen(outfile, 'w');
  for j = 1:length(peak_times)
    fprintf(fid, '%.6f,%.6f\n', peak_times(j), amps(j));
  end
  fclose(fid);
end
