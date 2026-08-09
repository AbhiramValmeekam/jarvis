# Generate speech fixtures for the voice pipeline, using Windows SAPI.
#
# These exist so wake-word and STT accuracy can be tested without a human at a
# microphone. SAPI is already on every Windows box, needs no download, and
# produces a genuine 16 kHz mono audio path -- the same format the daemon
# consumes from ffmpeg -- so the models are exercised for real rather than
# handed a mocked score.
#
# Run: powershell -ExecutionPolicy Bypass -File scripts/make-voice-fixtures.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$dir = Join-Path $PSScriptRoot '..\.research\audio'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$dir = (Resolve-Path $dir).Path

$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
    16000,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono)

# Positives must fire the wake word; negatives must not. "hey computer" is the
# interesting negative: same cadence, same leading word, different name.
$clips = [ordered]@{
    'hey_jarvis'   = 'hey jarvis'
    'jarvis_cmd'   = 'hey jarvis, what time is it'
    'hey_computer' = 'hey computer'
    'unrelated'    = 'the weather tomorrow looks quite pleasant'
}

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    foreach ($name in $clips.Keys) {
        $path = Join-Path $dir "$name.wav"
        $synth.SetOutputToWaveFile($path, $fmt)
        $synth.Speak($clips[$name])
        Write-Host ("  {0,-14} {1}" -f $name, $path)
    }
} finally {
    $synth.SetOutputToNull()
    $synth.Dispose()
}

Write-Host "voice fixtures written to $dir"
