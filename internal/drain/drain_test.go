package drain

import (
	"errors"
	"testing"
	"time"
)

func TestDrainClearsPopErrorAfterSuccessfulPop(t *testing.T) {
	d := &Drain{}
	d.recordError("pop", errors.New("redis down"))

	d.recordPopSuccess(time.Now())

	st := d.Status()
	if st.LastError != "" {
		t.Fatalf("LastError = %q, want cleared", st.LastError)
	}
	if st.BatchesPopped != 1 {
		t.Fatalf("BatchesPopped = %d, want 1", st.BatchesPopped)
	}
}

func TestDrainDoesNotClearInsertErrorAfterOnlyPop(t *testing.T) {
	d := &Drain{}
	d.recordError("insert", errors.New("sqlite locked"))

	d.recordPopSuccess(time.Now())

	st := d.Status()
	if st.LastError != "sqlite locked" {
		t.Fatalf("LastError = %q, want insert error retained", st.LastError)
	}
}

func TestDrainClearsInsertErrorAfterSuccessfulInsert(t *testing.T) {
	d := &Drain{}
	d.recordError("insert", errors.New("sqlite locked"))

	d.recordInsertSuccess(time.Now(), 3, 2)

	st := d.Status()
	if st.LastError != "" {
		t.Fatalf("LastError = %q, want cleared", st.LastError)
	}
	if st.TotalInserted != 3 || st.TotalDeduped != 2 {
		t.Fatalf("totals = inserted %d deduped %d, want 3/2", st.TotalInserted, st.TotalDeduped)
	}
}
