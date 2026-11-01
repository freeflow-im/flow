import { FindBox, FindToggle } from '../find/FindBox.tsx';
import type { SheetController } from '../state/controller.ts';
import type { SearchOptions } from '../state/search.ts';
import { useController } from '../state/useController.ts';

/** The spreadsheet's find bar: the shared FindBox with the spreadsheet's options. */
export function FindBar({ ctl }: { ctl: SheetController }) {
  useController(ctl);
  const s = ctl.search!;
  const hits = ctl.searchMatches();
  const toggle = (key: keyof Omit<SearchOptions, 'query'>) => ctl.setSearchOptions({ [key]: !s[key] });

  return (
    <FindBox
      query={s.query}
      onQuery={(query) => ctl.setSearchOptions({ query })}
      count={hits.length}
      current={s.current}
      onStep={(dir) => ctl.searchStep(dir)}
      onClose={() => ctl.closeSearch()}
      focusSeq={s.focusSeq}
      placeholder={s.allTabs ? 'Find in all sheets' : 'Find in sheet'}
      label="Find in spreadsheet"
    >
      <FindToggle on={s.matchCase} title="Match case" onClick={() => toggle('matchCase')}>
        Aa
      </FindToggle>
      <FindToggle on={s.wholeCell} title="Match entire cell contents" onClick={() => toggle('wholeCell')}>
        [ab]
      </FindToggle>
      <FindToggle on={s.formulas} title="Also search within formulas" onClick={() => toggle('formulas')}>
        fx
      </FindToggle>
      <FindToggle on={s.allTabs} title="Search all sheets" onClick={() => toggle('allTabs')}>
        All sheets
      </FindToggle>
    </FindBox>
  );
}
